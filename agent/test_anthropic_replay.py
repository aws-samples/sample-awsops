from types import SimpleNamespace as B

import anthropic_loop as al


def test_thinking_blocks_replayed_verbatim_in_order():
    blocks = [{"type": "thinking", "thinking": "p", "signature": "s"},
              {"type": "redacted_thinking", "data": "d"},
              {"type": "tool_use", "id": "t", "name": "x", "input": {}}]
    assert al._assistant_content(B(content=[B(**b) for b in blocks])) == blocks
