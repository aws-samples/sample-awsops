#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m unittest scripts.v2.test_claude_review scripts.v2.test_pr_review_pipeline scripts.v2.test_pr_review_head_images scripts.v2.test_pr_review_batches
