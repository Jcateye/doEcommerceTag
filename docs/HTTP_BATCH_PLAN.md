# HTTP 批量方案（编辑页）

## 目标

基于抖店商品编辑页现有的 `schema.model`，通过 HTTP / schema patch 方式实现以下 4 个便捷操作：

1. **单独创建直播间编码（颜色分类）**
2. **单独填入商家编码**
3. **同时填入直播间编码和商家编码**
4. **检查直播间编码和商家编码映射是否正确**

---

## 当前已确认事实

从录制结果可确认：

- 编辑页存在完整商品模型：`schema.model`
- 可从以下请求体中拿到完整模型：
  - `POST /product_diagnose/tproduct/diagnose_product`
  - 若页面有联动，也可能出现在 `refetchSchema / asyncRefetchSchema` 请求体
- 当前商品的关键数据结构：
  - `schema.model.spec_detail.value`：规格结构
  - `schema.model.sku_detail.value`：SKU 列表
- 颜色分类位于：
  - `spec_detail.value[*].name === "颜色分类"`
- 商家编码位于：
  - `sku_detail.value[*].code`
- 库存位于：
  - `sku_detail.value[*].stock_info.stock_num`
  - `sku_detail.value[*].stock_info.stock_inc_num`
  - `sku_detail.value[*].self_sell_stock`
- SKU 与颜色分类的关联方式：
  - `sku_detail.value[*].spec_detail_ids[]`
  - 与 `spec_detail.value[*].spec_values[*].id` 对应

---

## 核心技术路线

统一走四段式：

1. **读取当前商品 schema**
2. **生成 patch / 变更计划**
3. **页面内预览 / 校验**
4. **提交更新（后续补齐 update/save 提交链路）**

也就是说，4 个功能本质上都是：

- 先读取当前 `schema.model`
- 在本地内存里改 `spec_detail` 和 `sku_detail`
- 输出差异
- 再调用最终提交接口

---

## 数据模型抽象

建议在插件里统一抽象成：

```ts
interface MappingRow {
  liveRoomCode: string   // 直播间编码，对应颜色分类，如 D401
  shopCode: string       // 商家编码
  size?: string          // 默认均码
}

interface ParsedSkuRow {
  color: string
  size: string
  code: string
  price: string
  stockNum: number | ''
  stockIncNum: number | ''
  selfSellStock: number | ''
  skuId: string
  specDetailIds: string[]
}
```

统一以 `color + size` 作为逻辑主键；单尺码商品可退化为只用 `color`。

---

## 功能拆解

### 1) 单独创建直播间编码（颜色分类）

输入：

- `liveRoomCode`
- 可选 `size`（默认取现有唯一尺码，如“均码”）
- 可选价格复制策略（默认复制参考 SKU 的价格）

处理：

1. 找到 `颜色分类` 规格项
2. 检查 `liveRoomCode` 是否已存在
3. 不存在则向 `spec_values[]` 追加一项新规格值
4. 同时向 `sku_detail.value[]` 追加对应 SKU 行
5. 新 SKU 默认：
   - `code = ''`
   - `price = 复制参考 SKU`
   - `stock_info = 复制默认结构`
   - `spec_detail_ids = [新颜色ID, 现有尺码ID]`

结果：

- 只新增颜色分类和 SKU 行
- 不写商家编码

注意：

- 这一功能本质上不是“只改 spec_values”，而是通常要同时补一条 SKU，否则规格不完整

---

### 2) 单独填入商家编码

输入：

- `liveRoomCode`
- `shopCode`

处理：

1. 根据 `颜色分类 -> spec_value.id`
2. 在 `sku_detail.value[]` 里找到对应 `spec_detail_ids` 的 SKU
3. 更新该 SKU 的 `code`
4. 不新增规格，不新增 SKU

结果：

- 只改已有 SKU 的 `code`

---

### 3) 同时填入直播间编码和商家编码

输入：

- `liveRoomCode`
- `shopCode`

处理：

1. 若颜色分类已存在：
   - 直接定位对应 SKU，更新 `code`
2. 若颜色分类不存在：
   - 新增颜色分类规格值
   - 新增对应 SKU
   - 给新 SKU 写入 `code`

结果：

- 一次完成“建颜色分类 + 写商家编码”

这个就是最常用模式，适合“货盘固定”的场景。

---

### 4) 检查直播间编码映射是否正确

输入：

- Excel / CSV / 手工输入映射表

处理：

1. 解析当前商品的 `颜色分类 -> SKU.code`
2. 和导入映射做 diff
3. 输出四类结果：
   - `matched`：一致
   - `missingColor`：Excel 有，但页面没有该颜色分类
   - `missingCode`：页面有颜色分类，但商家编码为空
   - `codeMismatch`：页面商家编码与 Excel 不一致
   - `extraInPage`：页面多出来的颜色分类

结果：

- 给用户一份清晰校验报告
- 可直接衔接功能 2 / 3 自动修复

---

## 推荐实现顺序

### Phase 1：读 + 查 + 对比（先落地）

先做：

- 读取当前商品 schema
- 解析颜色分类 / 商家编码 / 库存
- 导入 Excel
- 执行功能 4：检查映射是否正确

原因：

- 这部分已具备完整信息
- 风险最低
- 能马上验证 HTTP 数据链路是否稳定

### Phase 2：本地 patch 生成（不提交）

再做：

- 功能 1 / 2 / 3 的 patch 生成器
- 先在页面里显示“将新增/修改哪些规格和 SKU”
- 先不真正提交

原因：

- 先把 schema patch 算法打稳
- 避免直接写接口时难定位问题

### Phase 3：提交链路

最后补：

- 找到编辑页最终 update/save 提交接口，或页面内部统一提交方法
- 把 Phase 2 生成的 patch 真正提交到后端

这是当前唯一还没完全锁定的部分。

---

## 当前唯一关键 blocker

**编辑页最终“提交更新”的接口还没最终锁定。**

也就是说：

- 读当前数据：已经没问题
- 生成 patch：可以做
- 校验映射：可以做
- 真正批量写回服务端：还需要补最后的 update/save 链路

因此当前最稳的主线是：

1. 先把功能 4 做完整
2. 再把功能 1/2/3 做成 patch preview
3. 最后补提交

---

## 建议产品形态

页面面板改为 4 个动作：

- **解析当前规格**
- **检查编码映射**
- **生成变更预览**
- **提交 HTTP 更新**（灰置，待接通）

其中“生成变更预览”支持三种模式：

- 仅创建直播间编码
- 仅填写商家编码
- 同时创建并填写

---

## 结论

基于当前已录到的数据，**HTTP 路线已经足够支撑 1/2/3/4 的数据建模与校验逻辑**。

真正剩下的不是“能不能读”，而是：

- **什么时候把 patch 提交给编辑页后端**
- **提交时走哪个 update/save 链路**

所以接下来最合理的开发顺序是：

1. 先做功能 4（检查映射）
2. 再做功能 1/2/3 的 patch preview
3. 最后补提交接口
