# Keep in lockstep with LimiterConfig defaults in spc_render.py — nothing pins these together mechanically.
plugin "aws" {
  limiter "awsops_global" {
    max_concurrency = 4
    bucket_size = 4
    fill_rate = 2.0
  }
}

connection "aws" {
  plugin  = "aws@0.142.0"
  regions = ["ap-northeast-2"]
}
