# Negative fixture: a module job that bypasses the AI gateway. scripts/check-ai-boundary.sh must flag all three lines.
import openai
from workers.core.contracts.ai import _LOADER_TOKEN, EchoProvider

result = EchoProvider().generate("evil.t", [], {})
