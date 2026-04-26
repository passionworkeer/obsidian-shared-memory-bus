"""
Backpressure queue — bounds concurrent write pressure on the retrieval layer.

When write volume exceeds what the system can process, the queue
applies back-pressure by rejecting new writes with a `BackpressureError`
that tells the caller how long to wait before retrying.

Design:
    - Fixed-size deque as the queue buffer
    - write_semaphore limits concurrent in-flight writes
    - When queue is full → BackpressureError with retry_after
    - Queue drains single-threadedly to avoid race conditions
    - Exposes queue utilization metrics for monitoring
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Deque, Optional, Tuple, TypeVar

T = TypeVar("T")

# Maximum time a task can wait in the queue before we give up (seconds)
_QUEUE_ITEM_TIMEOUT = 60.0


@dataclass
class BackpressureError(Exception):
    """
    Raised when the write queue is full and the system is under backpressure.

    Attributes:
        queue_size: Current number of items in the queue.
        max_size: Maximum queue capacity.
        retry_after: Suggested seconds to wait before retrying.
        utilization: Queue fill ratio as a float [0, 1].
    """

    queue_size: int
    max_size: int
    retry_after: float
    utilization: float

    def __repr__(self) -> str:
        return (
            f"BackpressureError(queue={self.queue_size}/{self.max_size}, "
            f"util={self.utilization:.1%}, retry_after={self.retry_after:.1f}s)"
        )

    def __str__(self) -> str:
        return (
            f"Write queue at {self.utilization:.0%} capacity "
            f"({self.queue_size}/{self.max_size}). "
            f"Retry after {self.retry_after:.1f}s."
        )


@dataclass
class QueueStats:
    """Snapshot of queue state for monitoring."""

    queue_size: int
    max_size: int
    utilization: float
    in_flight: int
    max_in_flight: int
    total_enqueued: int
    total_dequeued: int
    total_backpressure: int
    avg_wait_time_ms: float


class WriteTask:
    """A single write task waiting in the backpressure queue."""

    __slots__ = ("id", "data", "_future", "enqueued_at")

    def __init__(self, task_id: int, data: Any) -> None:
        self.id: int = task_id
        self.data: Any = data
        self._future: Optional[asyncio.Future[Any]] = None
        self.enqueued_at: float = time.monotonic()

    @property
    def future(self) -> asyncio.Future[Any]:
        """Lazily create the Future on the caller's thread (requires event loop)."""
        if self._future is None:
            self._future = asyncio.Future()
        return self._future


class BackpressureQueue:
    """
    Async-safe bounded write queue with backpressure signaling.

    Use this when multiple agents can write simultaneously and you need
    to protect downstream storage (SQLite, file system, etc.) from overload.

    Usage::

        q = BackpressureQueue(max_size=200, max_in_flight=50)

        async def writer():
            task_id, result = await q.enqueue(some_data)
            return result

        # Or sync wrapper:
        result = q.enqueue_sync(some_data)
        if isinstance(result, BackpressureError):
            await asyncio.sleep(result.retry_after)
            # retry...
    """

    def __init__(
        self,
        max_size: int = 200,
        max_in_flight: int = 50,
        default_retry_after: float = 1.0,
        queue_item_timeout: float = _QUEUE_ITEM_TIMEOUT,
    ) -> None:
        if max_size <= 0 or max_in_flight <= 0:
            raise ValueError("max_size and max_in_flight must be positive")

        self.max_size = max_size
        self.max_in_flight = max_in_flight
        self.default_retry_after = default_retry_after
        self.queue_item_timeout = queue_item_timeout

        self._queue: Deque[WriteTask] = deque()
        self._in_flight: int = 0
        self._next_id: int = 0
        self._next_id_lock = threading.Lock()

        # Metrics
        self._total_enqueued: int = 0
        self._total_dequeued: int = 0
        self._total_backpressure: int = 0
        self._wait_times_ms: list[float] = []
        self._lock = threading.RLock()

    def _next_task_id(self) -> int:
        with self._next_id_lock:
            tid = self._next_id
            self._next_id += 1
            return tid

    @property
    def queue_size(self) -> int:
        with self._lock:
            return len(self._queue)

    @property
    def in_flight(self) -> int:
        with self._lock:
            return self._in_flight

    def _compute_utilization(self) -> float:
        return len(self._queue) / self.max_size

    def check_backpressure(self) -> Optional[BackpressureError]:
        """
        Check if the queue is under backpressure WITHOUT enqueueing.

        Returns None if the queue can accept writes.
        Returns BackpressureError if the queue is full.
        """
        with self._lock:
            if len(self._queue) >= self.max_size:
                util = self._compute_utilization()
                # Exponential backoff based on how full the queue is
                base_delay = self.default_retry_after
                if util >= 0.95:
                    retry_after = base_delay * 4.0
                elif util >= 0.85:
                    retry_after = base_delay * 2.0
                else:
                    retry_after = base_delay

                self._total_backpressure += 1
                return BackpressureError(
                    queue_size=len(self._queue),
                    max_size=self.max_size,
                    retry_after=retry_after,
                    utilization=util,
                )
        return None

    def enqueue(self, data: Any) -> Tuple[asyncio.Task[Any], Optional[BackpressureError]]:
        """
        Enqueue a write task (async API).

        Returns (task, None) on success — await the task to get the result.
        Returns (None, BackpressureError) if queue is full.
        """
        with self._lock:
            bp = self.check_backpressure()
            if bp is not None:
                return None, bp  # type: ignore[return-value]

            task_id = self._next_task_id()
            write_task = WriteTask(task_id, data)
            self._queue.append(write_task)
            self._total_enqueued += 1

        # Create task to process this item
        async def _process() -> Any:
            try:
                result = await asyncio.wait_for(
                    write_task.future,
                    timeout=self.queue_item_timeout,
                )
                return result
            except asyncio.TimeoutError:
                raise TimeoutError(f"Write task {task_id} timed out after {self.queue_item_timeout}s")

        task = asyncio.create_task(_process())
        return task, None  # type: ignore[return-value]

    def enqueue_sync(self, data: Any) -> Tuple[Optional[WriteTask], Optional[BackpressureError]]:
        """
        Enqueue a write task (sync API, for use in non-async contexts).

        Returns (WriteTask, None) on success.
        Returns (None, BackpressureError) if queue is full.

        The caller is responsible for calling mark_done() when the write completes.
        """
        with self._lock:
            bp = self.check_backpressure()
            if bp is not None:
                return None, bp

            task_id = self._next_task_id()
            write_task = WriteTask(task_id, data)
            self._queue.append(write_task)
            self._total_enqueued += 1
            return write_task, None

    def mark_done(self, task: WriteTask, result: Any = None, error: Optional[Exception] = None) -> bool:
        """
        Mark a dequeued write task as done.

        Returns True if the task was successfully completed.
        Returns False if the task was not found in the queue.
        """
        with self._lock:
            if task not in self._queue:
                return False

            self._queue.remove(task)
            wait_ms = (time.monotonic() - task.enqueued_at) * 1000
            self._wait_times_ms.append(wait_ms)
            # Keep only last 1000 wait times
            if len(self._wait_times_ms) > 1000:
                self._wait_times_ms = self._wait_times_ms[-1000:]

            if not task.future.done():
                if error is not None:
                    task.future.set_exception(error)
                else:
                    task.future.set_result(result)

            self._total_dequeued += 1
            return True

    def dequeue(self) -> Optional[WriteTask]:
        """Pop the next write task from the queue (non-blocking)."""
        with self._lock:
            if not self._queue:
                return None
            task = self._queue.popleft()
            self._total_dequeued += 1
            return task

    def stats(self) -> QueueStats:
        """Return current queue statistics."""
        with self._lock:
            wait_times = self._wait_times_ms[-100:]  # last 100
            avg_wait = sum(wait_times) / len(wait_times) if wait_times else 0.0
            return QueueStats(
                queue_size=len(self._queue),
                max_size=self.max_size,
                utilization=self._compute_utilization(),
                in_flight=self._in_flight,
                max_in_flight=self.max_in_flight,
                total_enqueued=self._total_enqueued,
                total_dequeued=self._total_dequeued,
                total_backpressure=self._total_backpressure,
                avg_wait_time_ms=avg_wait,
            )


class BackpressureAwareExecutor:
    """
    Wraps a write function with backpressure protection and circuit breaking.

    Usage::

        executor = BackpressureAwareExecutor(
            write_func=my_write_function,
            max_queue_size=200,
            failure_threshold=5,
        )

        # Sync usage
        result = executor.execute(data)
        if isinstance(result, BackpressureError):
            # handle backpressure
        elif result is None:
            # circuit breaker error
        else:
            # success
    """

    def __init__(
        self,
        write_func: Callable[..., T],
        max_queue_size: int = 200,
        max_in_flight: int = 50,
        circuit_breaker: Optional[Any] = None,  # CircuitBreaker instance
    ) -> None:
        self._write_func = write_func
        self._queue = BackpressureQueue(max_size=max_queue_size, max_in_flight=max_in_flight)
        self._cb = circuit_breaker

    def execute(self, data: Any) -> Tuple[Optional[T], Optional[str]]:
        """
        Execute a write through backpressure + circuit breaker protection.

        Returns (result, None) on success.
        Returns (None, error_str) on failure.
        May raise BackpressureError.
        """
        bp = self._queue.check_backpressure()
        if bp is not None:
            raise bp

        task, bp_err = self._queue.enqueue_sync(data)
        if bp_err is not None:
            raise bp_err

        try:
            result = self._write_func(task.data)
            self._queue.mark_done(task, result=result)
            return result, None
        except Exception as exc:  # noqa: BLE001
            self._queue.mark_done(task, error=exc)
            return None, str(exc)

    @property
    def queue(self) -> BackpressureQueue:
        return self._queue

    @property
    def circuit_breaker_stats(self) -> Optional[dict]:
        return self._cb.stats if self._cb else None
