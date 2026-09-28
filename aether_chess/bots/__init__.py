"""The bot standard.

Import from here rather than from the submodules, so the standard is a single
surface:

    from aether_chess.bots import BotManager, MoveRequest

To add a new bot, implement :class:`Bot` in a new module and register it. No
existing caller changes.
"""

from aether_chess.bots.base import (
    Bot,
    BotCapabilities,
    BotMove,
    BotUnavailableError,
    MoveRequest,
    clamp_time_limit,
    normalize_move,
)
from aether_chess.bots.maia3_bot import MAIA3_BOT_ID, Maia3Bot
from aether_chess.bots.manager import AUTO_BOT_ID, BotManager
from aether_chess.bots.mentor_bot import MENTOR_BOT_ID, MentorBot
from aether_chess.bots.stockfish_bot import StockfishBot, build_stockfish_bots

__all__ = [
    "AUTO_BOT_ID",
    "MAIA3_BOT_ID",
    "MENTOR_BOT_ID",
    "Bot",
    "BotCapabilities",
    "BotManager",
    "BotMove",
    "BotUnavailableError",
    "Maia3Bot",
    "MentorBot",
    "MoveRequest",
    "StockfishBot",
    "build_stockfish_bots",
    "clamp_time_limit",
    "normalize_move",
]
