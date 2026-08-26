from rca.graph import neighbors

def test_neighbors_both_directions_dedup_sorted():
    edges = [
        {"source": "vpc:1", "target": "alb:a"},
        {"source": "alb:a", "target": "ec2:x"},
        {"source": "ec2:x", "target": "rds:db"},
        {"source": "alb:a", "target": "ec2:x"},  # dup
    ]
    assert neighbors("ec2:x", edges) == ["alb:a", "rds:db"]
    assert neighbors("alb:a", edges) == ["ec2:x", "vpc:1"]
    assert neighbors("absent", edges) == []
