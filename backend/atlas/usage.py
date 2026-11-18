"""Resource metering for background jobs.

Each running job gets a Meter bound to its worker thread. Code deep inside the job (data providers, LLM
calls) reports usage through `current()` without needing the job context passed down.

What is measured, precisely:
* cpu_s        — CPU time of the job's worker thread (time.thread_time). Native code that spawns its own
                 threads would not be counted; SIGNAL's numerical work runs in the calling thread.
* wall_s       — elapsed time.
* data_requests — HTTP requests made to market-data providers.
* llm_tokens   — input + output tokens reported by the LLM API (0 when narration is disabled).
* rss_mb_peak  — peak resident memory of the whole backend process while the job ran (process-wide,
                 because Python threads share one address space; there is no per-thread memory figure).
"""
from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field


class ResourceLimit(Exception):
    """A hard limit was reached; the job stops and records which one."""


_local = threading.local()


def rss_mb() -> float:
    try:
        with open("/proc/self/statm") as f:
            pages = int(f.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") / 2**20
    except (OSError, ValueError, IndexError):
        return 0.0


@dataclass
class Limits:
    max_runtime_s: float = 900
    max_cpu_s: float | None = None  # remaining monthly CPU budget, if any
    max_data_requests: int | None = None
    max_llm_tokens: int | None = None  # remaining monthly token budget
    max_memory_mb: float | None = None


@dataclass
class Meter:
    limits: Limits = field(default_factory=Limits)
    data_requests: int = 0
    llm_tokens: int = 0
    rss_mb_peak: float = 0.0
    _wall0: float = field(default_factory=time.monotonic)
    _cpu0: float = field(default_factory=time.thread_time)
    _thread: int = field(default_factory=threading.get_ident)

    def bind(self) -> "Meter":
        _local.meter = self
        self._wall0, self._cpu0, self._thread = time.monotonic(), time.thread_time(), threading.get_ident()
        self.rss_mb_peak = rss_mb()
        return self

    @staticmethod
    def unbind() -> None:
        _local.meter = None

    @property
    def wall_s(self) -> float:
        return time.monotonic() - self._wall0

    @property
    def cpu_s(self) -> float:
        # Only meaningful from the job's own thread; other threads read the last sampled value.
        return time.thread_time() - self._cpu0 if threading.get_ident() == self._thread else self._cpu_sample

    _cpu_sample: float = 0.0

    def sample(self) -> None:
        if threading.get_ident() == self._thread:
            self._cpu_sample = time.thread_time() - self._cpu0
        self.rss_mb_peak = max(self.rss_mb_peak, rss_mb())

    def check(self) -> None:
        self.sample()
        L = self.limits
        if self.wall_s > L.max_runtime_s:
            raise ResourceLimit(f"runtime limit reached ({L.max_runtime_s:.0f}s)")
        if L.max_cpu_s is not None and self.cpu_s > L.max_cpu_s:
            raise ResourceLimit(f"compute budget reached ({L.max_cpu_s:.0f} CPU-seconds remaining this month)")
        if L.max_memory_mb is not None and self.rss_mb_peak > L.max_memory_mb:
            raise ResourceLimit(f"memory limit reached ({self.rss_mb_peak:.0f} MB > {L.max_memory_mb:.0f} MB)")

    def data_request(self) -> None:
        self.data_requests += 1
        if self.limits.max_data_requests is not None and self.data_requests > self.limits.max_data_requests:
            raise ResourceLimit(f"data request limit reached ({self.limits.max_data_requests} per job)")

    def llm_allowed(self, estimate_tokens: int) -> bool:
        L = self.limits.max_llm_tokens
        return L is None or self.llm_tokens + estimate_tokens <= L

    def add_llm_tokens(self, n: int) -> None:
        self.llm_tokens += int(n)

    def snapshot(self) -> dict:
        self.sample()
        return {"cpu_s": round(self.cpu_s, 3), "wall_s": round(self.wall_s, 3), "data_requests": self.data_requests,
                "llm_tokens": self.llm_tokens, "rss_mb_peak": round(self.rss_mb_peak, 1)}


def current() -> Meter | None:
    return getattr(_local, "meter", None)


def record_data_request() -> None:
    m = current()
    if m is not None:
        m.data_request()
