"""Observed DNS addresses stay internal; verify the actual model request boundary."""
import json

from diagnosis import discovery, observations, pillar_agents as agents
from diagnosis.budget import ReportBudget
from diagnosis.evidence import EvidenceIndex
from diagnosis.test_observations import bundle, dns, flow, ACCOUNT, NOW, START
from diagnosis.test_pillar_agents import FakeClient, response


def test_aaaa_dns_answer_is_scrubbed_from_actual_specialist_request(monkeypatch):
    monkeypatch.setattr(discovery, '_now', lambda: NOW)
    address = 'fd00:1234:5678::25'
    data = bundle()
    observations.project(data, [dns(answers=[{'Rdata': address, 'Type': 'AAAA', 'Class': 'IN'}])],
                         [flow(remoteIp=address)], start=START, end=NOW, source_id='offline-test')
    assert address in json.dumps(data)
    assert any(e['kind'] == 'observed_network_flow' for e in data['evidence'])
    client = FakeClient([response({'findings': []})])
    monkeypatch.setattr(agents, '_client', lambda *_: client)
    agents.analyze('reliability', EvidenceIndex(data, ACCOUNT),
                   model_id='global.anthropic.claude-sonnet-5-5', budget=ReportBudget('mid'))
    request = json.loads(client.calls[0]['body'])
    assert address not in client.calls[0]['body']
    assert '<ip>' in request['messages'][0]['content'][0]['text']
    assert address in json.dumps(data)
