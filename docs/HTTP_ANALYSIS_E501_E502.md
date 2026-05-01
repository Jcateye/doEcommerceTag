# HTTP 请求录制分析：E501 / E502 + ED1 / ED2

录制文件：`/Users/haoqi/Downloads/抖店请求录制-2026-05-01-16-59-03.json`

用户手动操作：

| 颜色分类自定义规格值 | 商家编码 |
| --- | --- |
| E501 | ED1 |
| E502 | ED2 |

## 总结论

这次抓到了最终提交接口：

```text
POST /product/tproduct/addWithSchema?check_status=1&...
```

响应：

```json
{
  "errno": 0,
  "code": 0,
  "data": {
    "product_id": "3817478853400592820"
  }
}
```

说明本次提交成功创建/保存出了商品 ID。

核心 payload 结构：

```text
request.schema.model.spec_detail.value
request.schema.model.sku_detail.value
```

这确认 HTTP 方案可行：不需要再硬刚 DOM 点击，可以考虑在页面上下文里读取/复用完整 schema model，批量 patch `spec_detail` 和 `sku_detail`，再调用 `addWithSchema`。

## 有效请求过滤

录制总数：299 条。

多数是埋点/监控/图片/配置请求，例如：

- `https://mcs.zijieapi.com/list`
- `https://mon.zijieapi.com/monitor_browser/collect/batch`
- 图片 CDN
- config GET

核心业务请求：

```text
/product/tproduct/getBadWordHint
/product/tproduct/refetchSchema
/product_diagnose/tproduct/diagnose_product
/product/tproduct/productPreDetect
/product/tproduct/verifyPriceV2
/product/tproduct/publishClickStat
/product/prettify/formatPrettifyForProduct
/product/tproduct/addWithSchema   <-- 最终提交接口
```

## 最终提交接口

录制序号：`261`

```text
POST /product/tproduct/addWithSchema?check_status=1&...
```

请求体顶层字段：

```text
schema
category_id
context
pass_through_extra
request_extra
check_status
session
appid
__token
_bid
_lid
```

其中核心是：

```text
schema.model
```

`schema.model` 有 32 个字段，包括：

```text
sku_detail
spec_detail
white_background_pic
after_sale
ai_gen_spec
alli_promotion_plan_switch
category_properties
category_property_pic
delivery_delay_day
description
freight_id
goods_category
pic
product_type
title
...
```

## 规格字段确认

路径：

```text
schema.model.spec_detail.value
```

有 2 个规格组：

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
  "cp_id": 4704,
  "id": "1863906682960944",
  "name": "尺码大小",
  "spec_values": [ ... ]
}
```

## E501 / E502 的规格值位置

路径：

```text
schema.model.spec_detail.value[0].spec_values[99]
schema.model.spec_detail.value[0].spec_values[100]
```

内容：

```json
{
  "id": "990627420759585872",
  "name": "E501",
  "cpv_id": 0
}
```

```json
{
  "id": "996686389860726983",
  "name": "E502",
  "cpv_id": 0
}
```

结论：

- 自定义颜色分类值只需要追加到 `颜色分类.spec_values`
- 新增自定义值的 `cpv_id` 为 `0`
- 新增自定义值的 `id` 是前端生成/页面状态生成的字符串 ID

## SKU 字段确认

路径：

```text
schema.model.sku_detail.value
```

最终 SKU 总数：101。

新增的两条：

```text
schema.model.sku_detail.value[99]
schema.model.sku_detail.value[100]
```

### E501 -> ED1

```json
{
  "id": "eb3a7a4c3fbb-19b111-fcd9c180b6bc",
  "stock_info": { "stock_num": 0 },
  "step_stock_info": {
    "stock_num": 0,
    "stock_inc_num": 0,
    "multi_delivery_day_stocks": [
      {
        "time_type": "15",
        "time_desc": "15天内",
        "stock_num": 0,
        "stock_inc_num": 0
      }
    ]
  },
  "sku_status": true,
  "confirm_no_barcode": false,
  "spec_detail_ids": [
    "990627420759585872",
    "1863906682961984"
  ],
  "price": "87",
  "code": "ED1"
}
```

### E502 -> ED2

```json
{
  "id": "5dfa4e54e0ba-f8617a-ef6048767289",
  "stock_info": { "stock_num": 0 },
  "step_stock_info": {
    "stock_num": 0,
    "stock_inc_num": 0,
    "multi_delivery_day_stocks": [
      {
        "time_type": "15",
        "time_desc": "15天内",
        "stock_num": 0,
        "stock_inc_num": 0
      }
    ]
  },
  "sku_status": true,
  "confirm_no_barcode": false,
  "spec_detail_ids": [
    "996686389860726983",
    "1863906682961984"
  ],
  "price": "98",
  "code": "ED2"
}
```

## 商家编码字段

确认：

```text
sku_detail.value[].code
```

映射：

```text
E501 -> sku.code = ED1
E502 -> sku.code = ED2
```

## SKU 组合规则

```text
sku.spec_detail_ids = [颜色分类规格值 ID, 尺码大小规格值 ID]
```

本次：

```text
E501 ID = 990627420759585872
E502 ID = 996686389860726983
均码 ID = 1863906682961984
```

所以：

```text
E501 SKU: [990627420759585872, 1863906682961984]
E502 SKU: [996686389860726983, 1863906682961984]
```

## 价格字段

本次新增 SKU 里有：

```text
E501 price = "87"
E502 price = "98"
```

这可能来自页面人工输入或页面默认/校验逻辑。批量方案需要决定价格来源：

1. 复制已有 SKU 的价格
2. 使用页面当前默认值
3. 让用户在插件面板配置统一价格
4. 不处理价格，只填商家编码和规格，让页面提示用户补齐

## HTTP 化方案判断

可行。

建议下一阶段不是 DOM 点击，而是：

1. 从最近一次业务请求中提取完整 `schema.model`
2. 找到 `spec_detail.value` 中 `name === "颜色分类"` 的规格组
3. 找到 `spec_detail.value` 中另一个规格组（当前是 `尺码大小`）的默认规格值，例如 `均码`
4. 为每条 Excel 映射生成：
   - 新颜色分类 spec value
   - 新 sku_detail row
5. 写入：
   - `schema.model.spec_detail.value[颜色分类].spec_values`
   - `schema.model.sku_detail.value`
6. 调用页面上下文 `fetch('/product/tproduct/addWithSchema?...')`

## 安全建议

不要直接默认执行最终提交。

应拆成 3 个按钮：

1. `分析当前商品模型`
   - 只读，不提交
2. `生成 HTTP 草稿预览`
   - 展示将新增哪些规格、哪些 SKU、哪些商家编码
3. `提交保存草稿`
   - 明确用户确认后才调用 `addWithSchema`

继续保持边界：

- 不点发布商品
- 不绕过验证码/风控
- 不写 Cookie
- 不请求未知接口
- 优先小批量试跑：1 条 -> 2 条 -> 5 条 -> 全部

## 关键实现风险

### 1. 新 ID 的生成方式

录制显示新增规格 ID / SKU ID 是前端生成的字符串：

```text
spec value id: 990627420759585872
sku id: eb3a7a4c3fbb-19b111-fcd9c180b6bc
```

需要进一步确认：

- 是否可以自己生成唯一字符串
- 是否必须遵循页面内部 ID 生成规则
- 是否服务端只要求同一 payload 内引用一致

建议先实现一次 1 条 HTTP dry-run/小批量提交验证。

### 2. addWithSchema 语义

接口名是 `addWithSchema`，本次返回了新 `product_id`。

对创建页是合适的；编辑页可能不是这个接口，可能需要另一个 update 接口。

### 3. check_status=1

本次接口参数有：

```text
check_status=1
```

需要确认这是保存草稿还是提交创建前校验状态。响应已返回 product_id，说明至少完成了一次创建/保存动作。

### 4. 风控/Token

接口 URL 和 body 中包含 `__token`、`n_token`、`token`、`_lid` 等动态字段。

插件不应该伪造这些字段，应从当前页面已有请求/模型中复用。
