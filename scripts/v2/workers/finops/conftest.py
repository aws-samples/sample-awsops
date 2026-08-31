import os
import sys

# scripts/v2/workers on path, matching diagnosis/conftest.py, so `import db`/`from finops import x`
# resolve the same way they do at runtime (worker_lambda.py/fargate_worker.py run from that dir).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
