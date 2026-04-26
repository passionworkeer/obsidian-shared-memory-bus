"""
Circuit Breaker — prevents cascading failures in the retrieval layer.

When the embedding provider or dense scoring path fails repeatedly,
the circuit "opens" to fail fast and stop hammering the failing service.
After a recovery timeout, it enters "half-open" state to probe recovery.

States:
    closed   → normal operation, calls go through
    open     → fail fast, no calls go through
    half-open → probing, one call allowed through

Usage::

    cb = CircuitBreaker(name="embedding", failure_threshold=5,
                        recovery_timeout=30.0, half_open_max_calls=3)

    result = cb.call(embedding_func, "my-query")
    if isinstance(result, CircuitOpen):
        return fallback_bm25_only()
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional, Tuple, TypeVar

T = TypeVar("T")

# Sentinel to signal circuit is open
_CIRCUIT_OPEN = object()


@dataclass
class CircuitOpen:
    """Returned when circuit is open and call is rejected."""

    name: str
    since: float  # timestamp when circuit opened
    retry_after: float  # seconds until half-open

    def __repr__(self) -> str:
        return f"CircuitOpen(name={self.name!r}, retry_after={self.retry_after:.1f}s)"


class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half-open"


@dataclass
class CircuitBreaker:
    """
    Thread-safe Circuit Breaker.

    Attributes:
        name: Identifier for this circuit (e.g. "embedding", "dense_score").
        failure_threshold: Number of consecutive failures to trigger open.
        recovery_timeout: Seconds before transitioning open→half-open.
        half_open_max_calls: How many test calls to allow in half-open state.
        slow_call_threshold: Seconds; calls slower than this count as "slow".
        slow_call_ratio_threshold: Ratio of slow calls to trigger open (0-1).
    """

    name: str
    failure_threshold: int = 5
    recovery_timeout: float = 30.0
    half_open_max_calls: int = 3
    slow_call_threshold: float = 5.0
    slow_call_ratio_threshold: float = 0.5

    _state: CircuitState = field(default=CircuitState.CLOSED, init=False)
    _failure_count: int = field(default=0, init=False)
    _slow_call_count: int = field(default=0, init=False)
    _total_calls_in_half_open: int = field(default=0, init=False)
    _last_failure_time: float = field(default=0.0, init=False)
    _last_slow_time: float = field(default=0.0, init=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False)

    def call(self, func: Callable[..., T], *args: Any, **kwargs: Any) -> Tuple[T, Optional[str]]:
        """
        Execute func(*args, **kwargs) through the circuit breaker.

        Returns (result, None) on success.
        Returns (CircuitOpen, error_str) when circuit is open.
        Returns (None, error_str) when func raises an exception.
        """
        with self._lock:
            now = time.monotonic()
            state_changed = False

            # State transition: open → half-open
            if self._state == CircuitState.OPEN:
                if now - self._last_failure_time >= self.recovery_timeout:
                    self._state = CircuitState.HALF_OPEN
                    self._total_calls_in_half_open = 0
                    state_changed = True

            # State transition: half-open → open (too many failures in half-open)
            if self._state == CircuitState.HALF_OPEN:
                if self._total_calls_in_half_open >= self.half_open_max_calls:
                    self._trip(now)
                    state_changed = True

            # Fail fast: circuit is open
            if self._state == CircuitState.OPEN:
                retry_after = max(0.0, self.recovery_timeout - (now - self._last_failure_time))
                return CircuitOpen(name=self.name, since=self._last_failure_time, retry_after=retry_after), \
                    f"circuit-open:{self.name}"

            # Execute call
            self._total_calls_in_half_open += 1
            call_start = now

        try:
            result = func(*args, **kwargs)
            call_duration = time.monotonic() - call_start

            with self._lock:
                is_slow = call_duration >= self.slow_call_threshold

                if self._state == CircuitState.HALF_OPEN:
                    # Success in half-open → close the circuit
                    self._close()
                    return result, None

                # Success in closed state
                self._failure_count = 0
                if is_slow:
                    self._slow_call_count += 1
                    self._last_slow_time = time.monotonic()
                    self._check_slow_ratio()
                return result, None

        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._last_failure_time = time.monotonic()

                if self._state == CircuitState.HALF_OPEN:
                    # Any failure in half-open → re-open immediately
                    self._trip(self._last_failure_time)
                    return None, f"circuit-breaker-error:{self.name}:{exc}"

                # Closed state: accumulate failures
                self._failure_count += 1
                if self._failure_count >= self.failure_threshold:
                    self._trip(self._last_failure_time)

            return None, f"circuit-breaker-error:{self.name}:{exc}"

    def _close(self) -> None:
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._slow_call_count = 0
        self._total_calls_in_half_open = 0

    def _trip(self, timestamp: float) -> None:
        self._state = CircuitState.OPEN
        self._last_failure_time = timestamp
        self._failure_count = 0
        self._slow_call_count = 0

    def _check_slow_ratio(self) -> None:
        """If too many recent calls were slow, trip the circuit."""
        if self._failure_count + self._slow_call_count == 0:
            return
        slow_ratio = self._slow_call_count / max(1, self._failure_count + self._slow_call_count)
        if slow_ratio >= self.slow_call_ratio_threshold:
            self._trip(time.monotonic())

    @property
    def state(self) -> CircuitState:
        with self._lock:
            return self._state

    @property
    def stats(self) -> dict:
        with self._lock:
            return {
                "name": self.name,
                "state": self._state.value,
                "failure_count": self._failure_count,
                "slow_call_count": self._slow_call_count,
                "last_failure_time": self._last_failure_time,
                "last_slow_time": self._last_slow_time,
                "total_calls_in_half_open": self._total_calls_in_half_open,
                "failure_threshold": self.failure_threshold,
                "recovery_timeout": self.recovery_timeout,
            }

    def reset(self) -> None:
        with self._lock:
            self._close()
            self._last_failure_time = 0.0
            self._last_slow_time = 0.0
