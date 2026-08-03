from retrieval.metrics_exporter import _is_allowed_host_header


def test_metrics_host_guard_accepts_loopback_hosts():
    assert _is_allowed_host_header("127.0.0.1:9091")
    assert _is_allowed_host_header("localhost:9091")
    assert _is_allowed_host_header("[::1]:9091")


def test_metrics_host_guard_rejects_rebinding_and_malformed_hosts():
    assert not _is_allowed_host_header("evil.example:9091")
    assert not _is_allowed_host_header("127.0.0.1.evil.example")
    assert not _is_allowed_host_header("127.0.0.1:invalid")
    assert not _is_allowed_host_header("user@127.0.0.1:9091")
    assert not _is_allowed_host_header("")
    assert not _is_allowed_host_header("127.0.0.1:9091\r\nX-Test: injected")
