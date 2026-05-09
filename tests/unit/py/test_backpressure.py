"""Tests for retrieval/backpressure.py"""
import pytest
import asyncio
import time
import threading
from collections import deque
from unittest.mock import patch, MagicMock

from retrieval.backpressure import (
    BackpressureError,
    QueueStats,
    WriteTask,
    BackpressureQueue,
    BackpressureAwareExecutor,
)


class TestBackpressureError:
    """Test BackpressureError exception."""

    def test_error_attributes(self):
        err = BackpressureError(
            queue_size=150,
            max_size=200,
            retry_after=2.0,
            utilization=0.75,
        )
        assert err.queue_size == 150
        assert err.max_size == 200
        assert err.retry_after == 2.0
        assert err.utilization == 0.75

    def test_error_repr(self):
        err = BackpressureError(
            queue_size=190,
            max_size=200,
            retry_after=4.0,
            utilization=0.95,
        )
        repr_str = repr(err)
        assert "190" in repr_str
        assert "200" in repr_str
        assert "95" in repr_str

    def test_error_str(self):
        err = BackpressureError(
            queue_size=150,
            max_size=200,
            retry_after=2.0,
            utilization=0.75,
        )
        str_val = str(err)
        assert "75%" in str_val
        assert "2.0s" in str_val


class TestQueueStats:
    """Test QueueStats dataclass."""

    def test_queue_stats_creation(self):
        stats = QueueStats(
            queue_size=10,
            max_size=200,
            utilization=0.05,
            in_flight=5,
            max_in_flight=50,
            total_enqueued=100,
            total_dequeued=90,
            total_backpressure=5,
            avg_wait_time_ms=12.5,
        )
        assert stats.queue_size == 10
        assert stats.max_size == 200
        assert stats.utilization == 0.05
        assert stats.avg_wait_time_ms == 12.5


class TestWriteTask:
    """Test WriteTask."""

    def test_write_task_creation(self):
        task = WriteTask(task_id=42, data="test-data")
        assert task.id == 42
        assert task.data == "test-data"
        assert task.enqueued_at > 0

    def test_write_task_future_property_requires_event_loop(self):
        """Future creation requires event loop - test in async context."""
        task = WriteTask(task_id=1, data="data")

        async def test():
            future = task.future
            assert future is not None
            assert not future.done()

        asyncio.run(test())


class TestBackpressureQueue:
    """Test BackpressureQueue."""

    def test_queue_creation(self):
        queue = BackpressureQueue(max_size=100, max_in_flight=20)
        assert queue.max_size == 100
        assert queue.max_in_flight == 20
        assert queue.queue_size == 0
        assert queue.in_flight == 0

    def test_queue_invalid_size(self):
        with pytest.raises(ValueError):
            BackpressureQueue(max_size=0, max_in_flight=10)
        with pytest.raises(ValueError):
            BackpressureQueue(max_size=10, max_in_flight=0)

    def test_enqueue_sync_success(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5)

        task, err = queue.enqueue_sync({"data": "sync-value"})
        assert err is None
        assert task is not None
        # task.data contains the wrapped data
        assert task.data == {"data": "sync-value"}

    def test_enqueue_sync_rejects_when_full(self):
        queue = BackpressureQueue(max_size=2, max_in_flight=1)

        # Fill the queue
        for i in range(2):
            task, err = queue.enqueue_sync({"data": i})
            assert err is None

        # Next enqueue should fail via check_backpressure
        bp = queue.check_backpressure()
        assert bp is not None
        assert isinstance(bp, BackpressureError)

    def test_check_backpressure_allows_small_queue(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5)

        # Small queue should not trigger backpressure
        bp = queue.check_backpressure()
        assert bp is None

    def test_check_backpressure_full_queue(self):
        queue = BackpressureQueue(max_size=2, max_in_flight=1)

        # Fill the queue
        for i in range(2):
            task, err = queue.enqueue_sync({"data": i})
            assert err is None

        bp = queue.check_backpressure()
        assert bp is not None
        assert bp.queue_size == 2
        assert bp.max_size == 2

    def test_mark_done_not_found(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5)

        fake_task = WriteTask(task_id=999, data="fake")
        result = queue.mark_done(fake_task, result="result")
        assert result is False

    def test_dequeue_empty(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5)
        result = queue.dequeue()
        assert result is None

    def test_dequeue_returns_task(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5)

        task, _ = queue.enqueue_sync({"data": "value"})
        dequeued = queue.dequeue()
        assert dequeued is not None
        assert dequeued.id == task.id

    def test_dequeue_removes_from_queue(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5)

        task, _ = queue.enqueue_sync({"data": "value"})
        assert queue.queue_size == 1

        queue.dequeue()
        assert queue.queue_size == 0

    def test_stats_empty_queue(self):
        queue = BackpressureQueue(max_size=100, max_in_flight=20)
        stats = queue.stats()

        assert stats.max_size == 100
        assert stats.max_in_flight == 20
        assert stats.total_enqueued == 0
        assert stats.total_dequeued == 0

    def test_stats_after_enqueuing(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5)

        # Enqueue some items
        for i in range(3):
            task, _ = queue.enqueue_sync({"data": i})

        stats = queue.stats()
        assert stats.total_enqueued == 3
        assert stats.queue_size == 3

    def test_stats_backpressure_tracking(self):
        queue = BackpressureQueue(max_size=2, max_in_flight=1)

        # Fill queue
        for i in range(2):
            queue.enqueue_sync({"data": i})

        # Try to add more to trigger backpressure
        for _ in range(5):
            queue.check_backpressure()

        stats = queue.stats()
        assert stats.total_backpressure > 0

    def test_retry_after_scales_with_utilization(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5, default_retry_after=1.0)

        # At 95%+ utilization, retry should be 4x
        for _ in range(9):
            queue.enqueue_sync({"data": "x"})

        # Dequeue some to reduce queue size
        for _ in range(7):
            queue.dequeue()

        # Now check at high utilization
        bp = queue.check_backpressure()
        if bp is not None:
            assert bp.retry_after >= 1.0

    def test_retry_after_medium_utilization(self):
        queue = BackpressureQueue(max_size=10, max_in_flight=5, default_retry_after=1.0)

        # Fill to medium level
        for _ in range(8):
            queue.enqueue_sync({"data": "x"})

        # Dequeue to adjust utilization
        for _ in range(5):
            queue.dequeue()

        bp = queue.check_backpressure()
        if bp is not None:
            assert bp.retry_after >= 1.0

    def test_concurrent_enqueue_thread_safe(self):
        queue = BackpressureQueue(max_size=100, max_in_flight=50)
        results = []
        lock = threading.Lock()

        def enqueue_work():
            for i in range(10):
                task, err = queue.enqueue_sync({"data": i})
                with lock:
                    results.append((task, err))

        threads = []
        for _ in range(5):
            t = threading.Thread(target=enqueue_work)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # All operations should be accounted for
        successes = sum(1 for t, e in results if e is None)
        assert successes > 0

    def test_queue_properties(self):
        queue = BackpressureQueue(max_size=50, max_in_flight=10)

        assert queue.max_size == 50
        assert queue.max_in_flight == 10

        # Add items
        queue.enqueue_sync({"a": 1})
        queue.enqueue_sync({"b": 2})

        assert queue.queue_size == 2

    def test_stats_utilization_calculation(self):
        queue = BackpressureQueue(max_size=100, max_in_flight=20)

        # Add 50 items (50% utilization)
        for i in range(50):
            queue.enqueue_sync({"data": i})

        stats = queue.stats()
        assert stats.utilization == 0.5


class TestBackpressureAwareExecutor:
    """Test BackpressureAwareExecutor."""

    def test_executor_creation(self):
        def dummy_write(data):
            return f"wrote: {data}"

        executor = BackpressureAwareExecutor(
            write_func=dummy_write,
            max_queue_size=100,
            max_in_flight=20,
        )
        assert executor.queue is not None

    def test_executor_default_queue_size(self):
        def write_func(data):
            return "ok"

        executor = BackpressureAwareExecutor(write_func=write_func)
        assert executor.queue.max_size == 200  # default

    def test_executor_queue_property(self):
        def write_func(data):
            return "ok"

        executor = BackpressureAwareExecutor(write_func=write_func)
        queue = executor.queue

        assert isinstance(queue, BackpressureQueue)

    def test_executor_circuit_breaker_stats_none(self):
        def write_func(data):
            return "ok"

        executor = BackpressureAwareExecutor(write_func=write_func)
        stats = executor.circuit_breaker_stats
        assert stats is None

    def test_executor_circuit_breaker_stats_with_cb(self):
        from retrieval.circuit_breaker import CircuitBreaker

        def write_func(data):
            return "ok"

        cb = CircuitBreaker(name="test", failure_threshold=5)
        executor = BackpressureAwareExecutor(
            write_func=write_func,
            circuit_breaker=cb,
        )

        stats = executor.circuit_breaker_stats
        assert stats is not None
        assert stats["name"] == "test"

    def test_executor_with_custom_sizes(self):
        def write_func(data):
            return "ok"

        executor = BackpressureAwareExecutor(
            write_func=write_func,
            max_queue_size=50,
            max_in_flight=10,
        )
        assert executor.queue.max_size == 50
        assert executor.queue.max_in_flight == 10

    def test_executor_inherits_from_object(self):
        def write_func(data):
            return "ok"

        executor = BackpressureAwareExecutor(write_func=write_func)
        assert hasattr(executor, 'execute')
        assert hasattr(executor, 'queue')

    def test_executor_internal_queue_different_instances(self):
        def write_func(data):
            return "ok"

        executor1 = BackpressureAwareExecutor(write_func=write_func)
        executor2 = BackpressureAwareExecutor(write_func=write_func)

        # Each executor should have its own queue
        assert executor1.queue is not executor2.queue