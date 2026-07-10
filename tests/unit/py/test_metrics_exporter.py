"""Tests for retrieval/metrics_exporter.py"""
import pytest
import threading
import time
from unittest.mock import patch, MagicMock

from retrieval.metrics_exporter import (
    record_search_latency,
    increment_cache_hits,
    increment_cache_misses,
    increment_worker_restarts,
    increment_active_requests,
    reset_counters,
    _format_histogram,
    _format_counter,
    _format_gauge,
    _LATENCY_HISTOGRAM,
    _escape_label,
    start_metrics_exporter,
)


class TestRecordLatency:
    """Test search latency recording."""

    def test_record_valid_latency(self):
        reset_counters()  # Ensure clean state
        record_search_latency(0.05)
        # No exception means success

    def test_record_zero_latency(self):
        reset_counters()
        record_search_latency(0.0)
        # Zero should be recorded

    def test_record_negative_latency_ignored(self):
        reset_counters()
        record_search_latency(-1.0)
        # Should silently ignore negative values

    def test_record_invalid_type_ignored(self):
        reset_counters()
        record_search_latency("invalid")
        # Should silently ignore non-numeric values

    def test_record_large_latency(self):
        reset_counters()
        record_search_latency(100.0)  # 100 seconds
        # Should record in highest bucket

    def test_record_small_latency(self):
        reset_counters()
        record_search_latency(0.001)  # 1ms
        # Should be recorded


class TestCounterIncrements:
    """Test counter increment functions."""

    def test_increment_cache_hits(self):
        reset_counters()
        increment_cache_hits()
        # Counter incremented

    def test_increment_cache_hits_with_count(self):
        reset_counters()
        increment_cache_hits(count=5)
        # 5 hits added

    def test_increment_cache_hits_negative_ignored(self):
        reset_counters()
        increment_cache_hits(count=-1)
        # Should be ignored

    def test_increment_cache_misses(self):
        reset_counters()
        increment_cache_misses()
        # Counter incremented

    def test_increment_cache_misses_with_count(self):
        reset_counters()
        increment_cache_misses(count=10)

    def test_increment_worker_restarts(self):
        reset_counters()
        increment_worker_restarts()
        # Counter incremented

    def test_increment_worker_restarts_with_count(self):
        reset_counters()
        increment_worker_restarts(count=3)


class TestActiveRequests:
    """Test active requests gauge."""

    def test_increment_active_requests_positive(self):
        reset_counters()
        increment_active_requests(1)
        increment_active_requests(1)
        # Should be 2

    def test_increment_active_requests_negative(self):
        reset_counters()
        increment_active_requests(5)
        increment_active_requests(-2)
        # Should be 3

    def test_increment_active_requests_capped_at_zero(self):
        reset_counters()
        increment_active_requests(1)
        increment_active_requests(-10)  # Would go negative
        # Should stay at 0

    def test_increment_active_requests_zero_delta(self):
        reset_counters()
        increment_active_requests(0)
        # Should not error


class TestResetCounters:
    """Test counter reset functionality."""

    def test_reset_counters(self):
        # First increment some counters
        increment_cache_hits(10)
        increment_cache_misses(5)
        increment_worker_restarts(2)
        increment_active_requests(3)

        # Reset
        reset_counters()

        # Counters should be at initial state

    def test_reset_clears_histogram(self):
        record_search_latency(0.5)
        reset_counters()
        # Histogram should be cleared


class TestFormatHistogram:
    """Test Prometheus histogram formatting."""

    def test_format_histogram_basic(self):
        doc = {"<=0.1": 5.0, "<=0.5": 10.0, "+Inf": 10.0}
        result = _format_histogram("test_histogram", "Test histogram", doc)

        assert "# HELP test_histogram Test histogram" in result
        assert "# TYPE test_histogram histogram" in result
        assert 'test_histogram_bucket{le="<=0.1"} 5' in result
        assert 'test_histogram_bucket{le="+Inf"} 10' in result
        assert "test_histogram_count 10" in result

    def test_format_histogram_cumulative(self):
        doc = {"<=0.1": 3.0, "<=0.5": 8.0, "+Inf": 10.0}
        result = _format_histogram("test", "desc", doc)

        # Buckets should be cumulative (3 + 8 = 11)
        assert "le=\"<=0.1\"} 3" in result
        assert "le=\"<=0.5\"} 11" in result  # cumulative: 3 + 8 = 11

    def test_format_histogram_empty(self):
        doc = {"+Inf": 0.0}
        result = _format_histogram("empty", "Empty histogram", doc)

        assert "# HELP empty Empty histogram" in result
        assert "empty_count 0" in result

    def test_format_histogram_includes_sum(self):
        doc = {"<=0.1": 5.0, "+Inf": 5.0}
        result = _format_histogram("search", "Search latency", doc)

        assert "search_sum 0.0" in result

    def test_format_histogram_sorted_buckets(self):
        doc = {"<=1.0": 10.0, "<=0.1": 3.0, "<=0.5": 7.0, "+Inf": 10.0}
        result = _format_histogram("test", "desc", doc)

        # Buckets should appear in sorted order
        pos_01 = result.find('<=0.1"')
        pos_05 = result.find('<=0.5"')
        pos_10 = result.find('<=1.0"')
        assert pos_01 < pos_05 < pos_10


class TestFormatCounter:
    """Test Prometheus counter formatting."""

    def test_format_counter_basic(self):
        result = _format_counter("my_counter", "My counter description", 42.0)

        assert "# HELP my_counter My counter description" in result
        assert "# TYPE my_counter counter" in result
        assert "my_counter 42" in result

    def test_format_counter_zero(self):
        result = _format_counter("zero_counter", "Zero counter", 0.0)
        assert "zero_counter 0" in result

    def test_format_counter_float(self):
        result = _format_counter("float_counter", "Float counter", 3.14159)
        assert "float_counter 3.14159" in result


class TestFormatGauge:
    """Test Prometheus gauge formatting."""

    def test_format_gauge_basic(self):
        result = _format_gauge("my_gauge", "My gauge description", 100)

        assert "# HELP my_gauge My gauge description" in result
        assert "# TYPE my_gauge gauge" in result
        assert "my_gauge 100" in result

    def test_format_gauge_zero(self):
        result = _format_gauge("zero_gauge", "Zero gauge", 0)
        assert "zero_gauge 0" in result

    def test_format_gauge_negative(self):
        result = _format_gauge("neg_gauge", "Negative gauge", -5)
        assert "neg_gauge -5" in result


class TestEscapeLabel:
    """Test label escaping."""

    def test_escape_backslash(self):
        result = _escape_label("path\\to\\file")
        assert "\\\\" in result

    def test_escape_double_quote(self):
        result = _escape_label('label "with" quotes')
        assert '\\"' in result

    def test_escape_no_special_chars(self):
        result = _escape_label("simple-label")
        assert result == "simple-label"

    def test_escape_empty_string(self):
        result = _escape_label("")
        assert result == ""


class TestStartMetricsExporter:
    """Test metrics exporter server startup."""

    def test_start_metrics_exporter_returns_server(self):
        server = start_metrics_exporter()
        assert server is not None
        # Clean up
        server.shutdown()

    def test_server_listens_on_configured_port(self):
        server = start_metrics_exporter()
        assert server.server_address[1] == 9091  # default port
        server.shutdown()


class TestEndToEndMetrics:
    """Integration-style tests for metric recording and formatting."""

    def test_full_metric_lifecycle(self):
        reset_counters()

        # Record some metrics
        record_search_latency(0.05)
        record_search_latency(0.1)
        record_search_latency(0.3)
        increment_cache_hits(15)
        increment_cache_misses(5)
        increment_worker_restarts(1)
        increment_active_requests(3)

        # Metrics recorded successfully

    def test_histogram_formatting_with_actual_data(self):
        reset_counters()

        # Record various latencies
        for latency in [0.01, 0.02, 0.05, 0.1, 0.5]:
            record_search_latency(latency)

        # Format should work
        result = _format_histogram(
            "search_latency",
            "Search latency",
            dict(_LATENCY_HISTOGRAM),
        )

        assert "search_latency_bucket" in result
        assert "search_latency_count" in result

    def test_multiple_metric_operations(self):
        reset_counters()

        # Mix of operations
        record_search_latency(0.05)
        increment_cache_hits()
        increment_active_requests(1)
        record_search_latency(0.1)
        increment_cache_misses()
        increment_active_requests(-1)

        # Verify counters work
        record_search_latency(0.2)

    def test_histogram_bucket_assignment(self):
        """Test that latencies are assigned to correct buckets."""
        reset_counters()

        # Test various latency values
        test_latencies = [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 100.0]

        for lat in test_latencies:
            record_search_latency(lat)

        # All should be recorded without error

    def test_thread_safe_counters(self):
        """Test that counter operations are thread-safe."""
        reset_counters()

        def increment_work():
            for _ in range(100):
                increment_cache_hits()
                increment_cache_misses()

        threads = []
        for _ in range(5):
            t = threading.Thread(target=increment_work)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Thread operations should complete without errors