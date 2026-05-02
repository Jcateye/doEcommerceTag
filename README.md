# doEcommerceTag

抖店商品编辑页 HTTP 规格分析 / 批量操作 Chrome 插件项目。

## 当前目标

围绕抖店商品编辑页现有 `schema.model`，走 HTTP / schema patch 方案完成：

- 读取当前商品全部颜色分类、商家编码、库存、价格
- 导入 Excel 映射（直播间编码 -> 商家编码）
- 检查页面现有映射是否正确
- 生成批量变更预览：
  - 仅创建直播间编码（颜色分类）
  - 仅填写商家编码
  - 同时创建直播间编码和商家编码
- 后续接通最终 update/save 提交链路

## 当前状态

此前 DOM 自动化方案已下线，主线已切换为：

- 页面内 HTTP 请求录制
- 从 `diagnose_product / refetchSchema` 等请求体解析完整 `schema.model`
- 基于 `spec_detail + sku_detail` 做规格/SKU 映射分析

## 当前已完成

- Manifest V3 插件骨架
- popup 导入 Excel 与本地 storage 存储
- 抖店创建/编辑页识别
- 页面右侧 HTTP 分析面板
- 跨 tab HTTP 请求录制
- 业务请求过滤与导出
- 从录制请求解析：颜色分类 / 尺码 / 商家编码 / 库存 / 价格
- 已确认关键数据来源：
  - `schema.model.spec_detail.value`
  - `schema.model.sku_detail.value`
  - `POST /product_diagnose/tproduct/diagnose_product`

## 当前未完成

- 映射检查 UI
- 变更 patch 生成器
- 编辑页最终 update/save 提交链路

## 文档

- 安装与试跑：`docs/INSTALL.md`
- 当前进度：`docs/PROGRESS.md`
- HTTP 方案拆解：`docs/HTTP_BATCH_PLAN.md`
- 历史分析：
  - `docs/HTTP_ANALYSIS_E501.md`
  - `docs/HTTP_ANALYSIS_E501_E502.md`
- 示例数据：`samples/live-room-mapping.csv`

## 推荐开发顺序

1. 先做“检查直播间编码映射是否正确”
2. 再做 3 类 patch preview：创建颜色分类 / 填商家编码 / 同时处理
3. 最后接通 update/save 提交链路
