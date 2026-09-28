"""The one definition of what Mentor's 1-10 strength setting means.

Mentor is the built-in custom bot, and its strength slider used to be
translated into a :class:`SearchConfig` in three different places, each with
its own numbers. That meant the Mentor that played a move, the Mentor the
evaluation bar scored with, and the Mentor the engine controller drove were
three different difficulties under one name.

Keeping the mapping here, apart from both the engine and the bot adapter, is
what makes "Mentor at strength 7" mean one thing. The functions are pure, so
the mapping can be checked without starting a search.

The clock is deliberately not part of this mapping. Budget-constrained think
time is sampled by :mod:`aether_chess.think_profile` and is shared by every
bot, so it arrives here as an already-resolved ``time_limit_sec``. The
level-derived fallback below exists only for callers with no clock and no
sampler, such as the engine controller.
"""

from __future__ import annotations

from aether_chess.engines.mentor_engine import SearchConfig

#: The strength scale the UI exposes, shared with the other bots so the slider
#: means the same thing whichever bot is selected.
MIN_STRENGTH = 1
MAX_STRENGTH = 10

#: Nodes per level. A depth of 18 needs a budget in the millions, so the node
#: limit has to grow faster than the depth limit or deep levels get cut off
#: before reaching the depth they were given.
_NODES_BASE = 200_000
_NODES_PER_LEVEL = 200_000

#: Transposition-table entries per level. Past a few hundred thousand entries
#: the table stops paying for itself within one move's budget, so this grows
#: more slowly than the node budget.
_TT_BASE = 200_000
_TT_PER_LEVEL = 50_000


def clamp_strength(strength: float) -> int:
    """Clamp any input onto the 1-10 scale as an int.

    Every entry point clamps, because a bad value from a config file or a
    stale settings blob should land on the nearest legal level rather than
    raise or, worse, produce a negative node budget.
    """
    return max(MIN_STRENGTH, min(MAX_STRENGTH, int(strength)))


def default_time_limit(strength: float) -> float:
    """Level-derived think time for callers with no clock and no sampler.

    Callers that have a clock should use the shared sampler in
    :mod:`aether_chess.think_profile` and pass the result in instead.
    """
    level = clamp_strength(strength)
    return min(0.95, 0.08 + level * 0.085)


def mentor_search_config(
    strength: float,
    time_limit_sec: float | None = None,
) -> SearchConfig:
    """Build the search configuration for a strength level.

    ``time_limit_sec`` overrides the level-derived default, which is how the
    bot adapter honours a think time sampled against the game clock.
    """
    level = clamp_strength(strength)
    if time_limit_sec is None:
        time_limit_sec = default_time_limit(level)
    return SearchConfig(
        # 10-28 plies across the scale. Mentor is a plain iterative-deepening
        # search with no transposition move ordering to prune with, so it
        # reaches far less depth per second than a UCI engine and needs the
        # range to stay shallow at the bottom.
        max_depth=8 + level * 2,
        max_nodes=_NODES_BASE + level * _NODES_PER_LEVEL,
        time_limit_sec=time_limit_sec,
        # Blends the top moves by weight. The top of the scale is 1.0, meaning
        # "always play the best move", so the weakest levels stay fallible and
        # a game against a strong Mentor still has a chance.
        difficulty=min(1.0, 0.5 + level * 0.05),
        tt_max_entries=_TT_BASE + level * _TT_PER_LEVEL,
        # Mentor is single-threaded by design: it is numba-jitted over Python
        # objects, and threads would contend on the GIL for no gain.
        threads=1,
    )
