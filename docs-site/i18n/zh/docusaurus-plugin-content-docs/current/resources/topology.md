---
sidebar_position: 3
title: 拓扑
description: 探索请求流（Route53 → CloudFront → LB → Target Group → 目标）图
---

import Screenshot from '@site/src/components/Screenshot';

# 拓扑

此页面可通过交互式图形探索请求流经的路径（**Route53 → CloudFront → Load Balancer → Target Group → 目标**）。

<Screenshot src="/screenshots/resources/topology.png" alt="请求流图" />

## 主要功能
### 请求流图
- 将 **Route53 → CloudFront → Load Balancer → Target Group → 目标**相连的流量路径以节点和边可视化。
- 节点按类型以颜色和图标区分，目标节点会根据 **healthy / unhealthy / draining** 等 health 状态变换颜色。图上方的信息行会显示当前图中存在的类型/health 颜色图例。
- 图形顶部显示当前的**节点数**、**边数**以及清单同步时刻。
- 通过屏幕右下角的 **MiniMap** 和左下角的 **Controls** 可以自由移动（pan）/缩放（zoom）。

### 入口点过滤器
- 通过顶部的 **CloudFront** 选择框选中特定分发后，可将图形缩小到仅保留从该入口点出发的路径。
- 通过 **LB** 选择框也可以按特定 Load Balancer 同样缩小范围。
- 两个选择框都设为**全部**时，将显示整个图形。

### 资源搜索
- 在顶部搜索框输入资源名称的一部分，会出现自动补全列表。
- 从列表中选择项目后，会立即聚焦到对应节点。按 **Enter** 会选中第一个匹配项。

### 聚焦模式 + 详情面板
- 点击节点会切换到**聚焦模式**，仅保留相连的上游/下游路径并在屏幕中央重新排列。
- 同时右侧会打开**详情面板**，显示该资源的字段。**VPC / subnet / security group ID** 会一并以便于人阅读的名称显示。
- 在面板中可通过 **复制 ARN** 按钮复制资源标识符，并通过**向 AI 提问**按钮直接向 AI 助手提问。
- 会一并提供符合资源类型的**推荐问题标签**，具有网络布局的资源还会显示**关系图**链接。
- 点击空白区域会取消选择并返回整个图形。

<Screenshot src="/screenshots/resources/topology-detail.png" alt="节点聚焦模式 + 详情面板" />

## 使用方法
1. 在侧边栏点击**拓扑**。
2. 图形绘制完成后，通过 **MiniMap** 和 **Controls** 放大查看所需区域。
3. 若只想查看特定入口点，在顶部 **CloudFront** 或 **LB** 选择框中选择目标。
4. 若有要找的资源，在搜索框输入名称的一部分，并从自动补全列表中选择。
5. 点击节点进入**聚焦模式**，在右侧**详情面板**中查看字段。
6. 如有需要，可使用**复制 ARN**、推荐问题标签、**向 AI 提问**、**关系图**链接。
7. 点击空白区域取消选择并返回整个图形。

## 使用技巧
:::tip 从入口点开始追踪
若想查看某个服务的完整路径，请通过 **CloudFront** 或 **LB** 选择框选中入口点后，沿着流向追踪到末端目标。通过目标节点的颜色可一目了然地掌握 health 状态。
:::

:::info 显示时刻
图形顶部的清单同步时刻和详情信息中的时刻均以韩国标准时间（KST, Asia/Seoul）为准。
:::

## AI 分析技巧
使用详情面板的推荐问题标签或**向 AI 提问**按钮时，AI 助手会在已填充所选资源上下文的状态下打开。示例问题：
- 这个 CloudFront 分发与源站之间是通过 TLS 通信的吗？
- 这个 Load Balancer 的监听器/目标 health 状态为什么是这样？
- 请诊断这个 Target Group 的 unhealthy 目标的原因。
- 请确认这个 IP 所属的实例/ENI 和安全组。

## 相关页面
- [资源清单](./inventory) - 按资源类型查询列表
- [AI 助手](../overview/assistant) - 携带从图中传递的上下文继续提问
