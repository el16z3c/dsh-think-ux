# dsh-think-ux（中文）

DeepSeek Harness (dsh) Web 端「思考盒」体验插件：模型推理时，think 行自动展开为 24 行限高预览，流式文本平滑上滚（指数追逐，70 ms 时间常数）；推理结束后预览以 180 ms 高度动画收起，而不是 ~490 px 的一帧跳变。主对话视图同样平滑追底：长会话打开飞速 swoosh 到底，流式插入以 ~960 px/s 匀速滑行；`scrollTop` 写陷阱把「读者意图」与「bundle 回钉」从结构上区分开，不再互相拉扯。

纯 DOM 客户端插件：不改 bundle、不申服务、不发网络请求。已在 DSH 0.1.5-rc.2 验证。

## 安装

```sh
dsh plugin --profile web add dsh-think-ux
```

刷新 Web 会话生效。其他 profile：`dsh plugin --profile <name> add dsh-think-ux`。

## 卸载

```sh
dsh plugin --profile web remove dsh-think-ux
```

刷新后回到官方默认行为，无需清理。

## 行为摘要

1. **思考盒**：流式推理时自动展开（合成点击，React 状态仍归 bundle）；用户自己点过的行永久交给用户，插件不再碰。settle 后自动收起，收起播放 `COLLAPSE_MS` 高度动画（`transitionend` 收尾 + 起点计时安全网；`COLLAPSE_MS = 0` 恢复瞬收）。预览限高 24 行、24 px 上下渐隐、隐藏滚动条，由 rAF 追踪器平滑追底；预览内向上滚暂停跟随，回到底部 25 px 内恢复。
2. **滚动意图**：读者向上滚（轮询/触摸/PageUp/Home/任意 scrollTop 上漂）武装 700 ms 意图窗口；窗口内 bundle 的「回钉」写入（`el.scrollTop = el.scrollHeight`）被同 tick 撤销、读者位置原样保留。落点距底 45 px 内视为读者回归，主动落底让 bundle 自己的 25 px 簿记恢复跟随；读者新消息/回底按钮的跳转放行。
3. **主视图滑行**：跟随模式下 bundle 回钉被交给指数追逐器；按「回合」选速——起始间隙 ≥ `GAP_FAST_MIN`(800 px) 全程纯指数（开长会话 swoosh），小于则恒定 `CHASE_MAX_PX`(16 px/帧 ≈ 960 px/s) 滑行；中途大插入可升级、不降级。同时禁用 scroller 的 `overflow-anchor`（大段插入的整块锚定偏移是一帧硬跳的根因之一，卸载时恢复原值）；`scrollTo`/`scrollBy` 影子把无意图的「滚到底」调用也交给追逐器（`scrollTo(x, y)` 按 DOM 规范读第二参数为纵坐标）。
4. **单实例接管**：会话切换会重建插件实例；最新实例接管整页（发布 `__DSH_THINK_UX_LIVE__` 并释放前任的全部观察者/陷阱/追踪器），杜绝多实例互踩。

## 开关与回滚

- `MAIN_SMOOTH_FOLLOW = false`：关主视图滑行（连同锚定覆盖、方法影子），思考盒功能不受影响。
- `COLLAPSE_MS = 0`：settle 瞬收（旧行为）。
- 完全回滚：上面「卸载」一条命令。

## 已知边界（诚实版）

已在 DSH 0.1.5-rc.2 验证，依赖该版本的 DOM 属性和客户端加载协议。详见英文 README 的 Residual risks：行为假设（稳定 DOM 属性、点击切换语义、bundle 的裸 `scrollTop` 写入路径）失效时，插件安静地退化为官方默认行为（不报错）。**退化承诺只覆盖行为假设**——注册/清单类错误不会安静退化：0.1.0 曾因客户端注册名与包名不一致，导致**整个 Web UI 加载失败**（页面显示 "Failed to load plugins"）。若见到该页面且点名 `dsh-think-ux`，请升级：`dsh plugin --profile web update dsh-think-ux`（npm 上 0.1.0 已标废，0.1.1 修复，注册名一致性测试随包）。
