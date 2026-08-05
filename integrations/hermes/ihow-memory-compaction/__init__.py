"""Hermes entry point for iHow Memory's explicit pre-compression provider."""

from .provider import IHowMemoryCompactionProvider


def register(ctx) -> None:
    ctx.register_memory_provider(IHowMemoryCompactionProvider())
