from types import SimpleNamespace as B

import anthropic_loop as al


def test_thinking_blocks_replayed_verbatim_in_order():
    blocks = [{"type": "thinking", "thinking": "p", "signature": "s"},
              {"type": "redacted_thinking", "data": "d"},
              {"type": "tool_use", "id": "t", "name": "x", "input": {}}]
    assert al._assistant_content(B(content=[B(**b) for b in blocks])) == blocks


def test_replay_omits_null_signature_and_empty_redacted_data():
    blocks = [B(type="thinking", thinking="p", signature=None), B(type="redacted_thinking", data=None),
              B(type="text", text="t")]
    assert al._assistant_content(B(content=blocks)) == [{"type": "thinking", "thinking": "p"},
                                                         {"type": "text", "text": "t"}]
