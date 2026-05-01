# HTTP 请求录制分析：E501

录制文件：`/Users/haoqi/Downloads/抖店请求录制-2026-05-01-16-29-28.json`

用户手动新增的颜色分类自定义规格值：`E501`

## 录制结果概览

共捕获 4 条请求：

1. `POST /product/tproduct/getBadWordHint?_field=spec_value...`
2. `POST /product/tproduct/refetchSchema?action=suggest_price_calc_for_price...`
3. `POST /product/tproduct/refetchSchema?action=alli_promotion_plan_switch_refresh...`
4. `POST /product_diagnose/tproduct/diagnose_product...`

其中 4 条请求体内都能搜到 `E501`。

## 关键发现

### 1. 新增颜色分类规格值后，前端 model 里会出现完整规格结构

在请求 1 / 2 / 3 的 `model.spec_detail.value`，以及请求 4 的 `schema.model.spec_detail.value` 中都有规格结构。

`spec_detail.value` 是规格组数组。

本次页面有 2 个规格组：

```text
spec_detail.value[0] = 颜色分类
spec_detail.value[1] = 尺码大小
```

颜色分类：

```json
{
  "cp_id": 2752,
  "id": "1863906682693692",
  "name": "颜色分类",
  "spec_values": [ ... ]
}
```

尺码大小：

```json
{
  "cp_id": 4704/4705 相关,
  "id": "1863906682960944",
  "name": "尺码大小",
  "spec_values": [
    {
      "id": "1863906682961984",
      "name": "均码",
      "cpv_id": 38314
    }
  ]
}
```

### 2. E501 被添加在颜色分类 spec_values 最后

路径：

```text
schema.model.spec_detail.value[0].spec_values[99]
```

内容：

```json
{
  "id": "993658611967896297",
  "name": "E501",
  "cpv_id": 0
}
```

注意：老的 D401-D500 自定义值很多都有：

```json
{
  "cpv_path": [
    {"cp_id": 4471, "cpv_id": 0},
    {"cp_id": 2752, "cpv_id": 0}
  ],
  "id": "1863906682694668",
  "name": "D401"
}
```

但本次新建的 `E501` 只有：

```json
{"id":"993658611967896297","name":"E501","cpv_id":0}
```

这说明新增自定义规格值不一定必须带 `cpv_path`，至少页面当前请求中是这样提交的。

### 3. SKU 明细会新增一行对应 E501 + 均码

路径：

```text
schema.model.sku_detail.value[99]
```

内容摘要：

```json
{
  "id": "0adf26b579a3-3df43d-162d7e7bb8c8",
  "stock_info": {"stock_num": 0},
  "step_stock_info": {
    "stock_num": 0,
    "stock_inc_num": 0,
    "multi_delivery_day_stocks": [
      {"time_type":"15","time_desc":"15天内","stock_num":0,"stock_inc_num":0}
    ]
  },
  "sku_status": true,
  "confirm_no_barcode": false,
  "spec_detail_ids": [
    "993658611967896297",
    "1863906682961984"
  ]
}
```

这里 `spec_detail_ids` 的含义：

```text
[颜色分类规格值ID, 尺码大小规格值ID]
```

即：

```text
E501 的 id = 993658611967896297
均码的 id = 1863906682961984
```

### 4. 本次没有看到最终保存接口

录制里没有明显的 `save draft / create product / update product` 最终提交接口。

捕获到的是：

- 敏感词检查：`getBadWordHint`
- schema 局部刷新：`refetchSchema`
- 商品诊断：`diagnose_product`

因此当前还不能直接构造最终 HTTP 保存请求。

下一步需要重新录制一次：

1. 开始录制请求
2. 手动新增一个规格值，例如 `E502`
3. 填写商家编码
4. 明确点击「保存草稿」
5. 等待页面提示保存成功/失败
6. 停止录制并导出 JSON

## 接口化可行性判断

从现有请求看，页面的核心状态都在 `model` / `schema.model` 中：

- `model.spec_detail.value`：规格组和值
- `model.sku_detail.value`：SKU 行和商家编码字段 `code`

这对接口化是好消息。

如果能拿到保存草稿接口，则可以考虑：

1. 从当前页面/请求中拿完整 `model`
2. 批量追加颜色分类 `spec_values`
3. 批量追加/更新 `sku_detail.value`
4. 使用页面上下文 `fetch` 调用原保存接口

但前提是必须捕获最终保存接口和完整 payload。

## 下一步工程建议

- recorder 已改为录制期间捕获所有 `fetch` / `XMLHttpRequest` / `sendBeacon`，不再按 URL 过滤，避免漏掉保存接口。
- 下一次录制时务必点击「保存草稿」。
- 分析新 JSON 后，再决定是否从 DOM 自动化切到模型 patch + HTTP 保存。
