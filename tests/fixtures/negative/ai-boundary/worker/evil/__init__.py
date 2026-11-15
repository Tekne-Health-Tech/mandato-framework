# Negative fixture: a module job that bypasses the AI gateway. scripts/check-ai-boundary.sh must flag all three lines.
import openai
from workers.core.contracts.ai import _LOADER_TOKEN, EchoProvider

result = EchoProvider().generate("evil.t", [], {})

# Aliases and attribute access (verification stage 8) must be caught too.
from workers.core.contracts.ai import EchoProvider as E  # noqa: E402
import workers.core.contracts.ai as ai  # noqa: E402
import importlib  # noqa: E402

E().generate("evil.t", [], {})
ai.EchoProvider().generate("evil.t", [], {})
ai.ClassifiedPart("text", "x", 0, _token=ai._LOADER_TOKEN)
importlib.import_module("open" + "ai")
