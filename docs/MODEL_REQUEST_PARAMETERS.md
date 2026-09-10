# 高级模型请求参数

模型管理页面和模型设置弹窗均提供按模型保存的高级请求参数。留空沿用应用现有请求。部分请求默认发送 thinking=disabled；选择“不发送，使用服务端默认”可移除该字段。

支持 temperature、top_p、max_tokens、max_completion_tokens、frequency_penalty、presence_penalty、reasoning_effort 和 thinking。校验范围不代表所有模型都支持。两个 token 上限不能同时配置；模型级上限覆盖现有输出上限，包括总结请求。

参数经前端和 Rust 校验后应用于请求顶层，从提示上下文移除。messages、model、response_format 等系统字段不可覆盖。参数用于分类、规划及修复重试、阶段决策、执行复核和总结。

存在自定义参数时，保存后的连接检查发送最小文本生成请求，可能产生费用。成功仅表示接口接受请求，不保证服务端实际采用所有参数。未设置高级参数时保留模型列表检查。

建议一次只调整 temperature 或 top_p 中的一项。过低的输出预算可能截断计划。推理参数仅在接口支持时启用。预览显示自定义字段，完整请求可在开发者日志查看。
