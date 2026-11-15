# dsh-go-adb-link

[![CI](https://github.com/chen114514st/dsh-go-adb-link/actions/workflows/ci.yml/badge.svg)](https://github.com/chen114514st/dsh-go-adb-link/actions/workflows/ci.yml)

DSH Go 原生插件：自动找到手机上的 ADB TCP 端口并保持连接。

本仓库：<https://github.com/chen114514st/dsh-go-adb-link>（二改版，版本 1.3.1）
二改于 <https://github.com/usi112/dsh-go-adb-link>
上游原版：<https://github.com/edgy7493/dsh-go-adb-link>

## 兼容性

- 适配 **DSH Go 1.0.16**（引擎 `r15-dsh0.2.2-rc.1-node24.22.1`，Android arm64）。
- 1.0.16 新增了「本机 ADB shell 工具」和「Shizuku/本机 ADB 自更新」，两者都会碰到 adbd；实测升级后本插件的 `127.0.0.1:3455` 通道会自动恢复，`lastError` 为空，无需重连或重装。
- 1.0.15 可用；更早的版本没有验证。

## 安装

市场已提交收录（PR 审核中），收录前可以先用下面的方式，效果一样：

1. **npm 安装**（推荐；国内镜像已同步）

   ```sh
   dsh plugin --profile web add dsh-go-adb-link
   ```

   提示找不到版本时，加官方源：`dsh plugin --profile web add dsh-go-adb-link --registry=https://registry.npmjs.org/`

2. **GitHub 直接装**

   ```sh
   dsh plugin --profile web add github:chen114514st/dsh-go-adb-link
   ```

3. **离线 tarball**：从 [Releases](https://github.com/chen114514st/dsh-go-adb-link/releases) 下载
   `dsh-go-adb-link-1.3.1.tgz` 放到手机，然后
   `dsh plugin --profile web add /sdcard/Download/dsh-go-adb-link-1.3.1.tgz`

装完到 App 的「引擎」页重启一次引擎，输入框上方的状态条就会出现。

装完状态条立即出现在输入框上方；`lib/` 代码改动需要到 App 的「引擎」页重启引擎。

## 首次授权（只需一次）

第一次连接时手机会弹出「允许 USB 调试吗」。请点**允许**，并**勾选「始终允许使用这台计算机进行调试」**。
勾了之后重连不再弹窗，插件才能全自动；没勾的话每次重连都要再点一次。

## 端口不是 3455 也能用吗

- **同一个手机换了端口**：可以。点「连接」会全端口扫描（1–65535），发 ADB 握手找 adbd，
  不看端口号；扫描只认 `CNXN`/`AUTH` 应答，并过滤 TCP 自连造成的误报。
- **另一个手机打开了 adb**：插件跑在哪台手机的环境里就找哪台，不会去连别的设备的局域网端口。
- **经典 ADB over TCP**（`adb tcpip`、Stellar 的 TCP 功能）可以直接扫描找到。
- Android 11+ 原生「无线调试」是 TLS 配对端口，握手探测不到，改用下面的配对流程。

自动重连先试记住的端口和 `3455`、`5555`；都不通且之前授权过，会在后台重扫。
- AI 工具支持传 `serial`（等价于 `adb -s`），多设备时不会连错机器。
- adb server 长时间掉线时，面板打开期间会每 5 分钟尝试 `adb start-server` 一次，再自动重连。

## 固定端口与无线调试配对（1.3.0）

**固定端口**：面板上的「固定端口」会执行 `adb tcpip 3455`，让 adbd 固定监听 3455。
它要求当前已有传输（已连上的 TCP 或插着 USB），手机整个掉线时没有地方下发这条命令，
所以全端口扫描的兜底仍然保留。执行后 adbd 会重启一次、连接短暂断开，插件会等端口重新
监听再自动连上；`tcpip` 设置**只对本次开机有效**，手机重启或 adbd 重启后要再点一次。
个别厂商 ROM 会限制 `adb tcpip`，失败时面板会提示。

**无线调试配对**：Android 11+ 在「开发者选项 → 无线调试 → 使用配对码配对设备」里显示
IP、配对端口和 6 位配对码。让 AI 用 `adb_pair` 工具完成配对：配对成功后插件用
`adb mdns services` 找 `_adb-tls-connect._tcp` 服务并自动 `adb connect`，地址会记进
`state.json` 的 `addr`，以后自动重连直接用这个地址；找不到连接端口时，让 AI 用
`connectPort` 参数重试（端口就在「无线调试」主页面）。
配对码是敏感信息：只交给 adb 一次，不写 `state.json`、不进面板「最近命令」、不回显，
工具调用卡上也用 `••••••` 代替。配对本身算系统级操作，工具层会拦下并要求在面板点「允许一次」。

TLS 配对记住的 `addr` 和固定端口的经典 TCP 是两条路径：点「固定端口」会清掉 `addr`、
切回经典模式；想再用无线调试就重新配对一次。

## 数据与安全

- 运行记忆写在 `$DSH_HOME/dsh-go/adb-link/state.json`（端口、是否授权、是否自动重连），
  不在插件包内，卸载/升级不会带走或误发。
- 插件会执行本机的 `adb` 程序；缺 adb 时会调用 `apt-get install -y adb`。
- 不读取剪贴板、输入框、对话内容；只连 `127.0.0.1` 上识别出的 adbd。
- 本机 adb server（`127.0.0.1:5037`）与 bash 共享，所以插件连上后普通 `adb` 命令也能用。
- 截图（`adb exec-out screencap -p`）按二进制保存成 PNG：优先 `/sdcard/Download/DSH-Go/`，写不进去就放 `$DSH_HOME/dsh-go/adb-link/out/`，不会把乱码塞进对话。

## AI 行为边界

插件不再只是笼统要求「主动使用 adb」，而是把边界写进给 AI 的系统提示和工具说明里：

- **先说再做**：AI 每次通过 adb 操作手机前，要先用一句话说明要做什么、为什么，不静默执行。
- **只读可直接查**：`devices`、`getprop`、`pm list`、`dumpsys`、`logcat -d`、截图、`uiautomator dump`、进程/电量/网络/温度查询这类不改变手机状态的命令，可以直接跑。
- **写文件也算写入**：`logcat` 不带 `-c` 但带 `-f`/`--file`/`-r`/`-n` 会写存储，按写入操作处理，需要你同意。
- **系统级 / 写入先征得同意**：安装卸载 APK、`appops` 改权限、`settings put/delete`、`input` 模拟点击输入、`am` 启动广播、强制停止、重启、删除或清空数据，必须先得到你的同意才执行。
- **红线不变**：登录、支付、验证码、删除重要数据等敏感操作永远不通过 adb 执行，仍按原有规则先确认。

插件面板里也会显示这条说明。之所以收紧，是因为手机上常有账号和支付信息，而开启自动批准后命令可能不经确认就执行；这样 AI 的行为更容易被看见和拦住。

### 限制不是只写在提示词里

- 工具层会先给命令分级：只读放行；系统级 / 写入停下；`rm`、`pm clear`、`format`、`dd of=/dev/block/*`、`sideload` 这类删数据命令直接红线拦截，没有放行途径。
- 被拦下时，面板会显示 AI 想执行的命令，并出现「允许一次」「拒绝」两个按钮。点「允许一次」只放行这一条、这个参数，120 秒后失效；授权只在内存里，不写盘，也不改 `state.json`。
- 放行只对完全相同的参数有效；AI 换参数会被重新拦下，提示词也明确要求它不许换参数绕过。

## 卸载

```sh
dsh plugin --profile web remove dsh-go-adb-link
```

也可以直接在 App 的插件详情里卸载。

## 更新日志

- **1.3.1**：`adb_pair` 纳入工具层 guard（配对按 confirm 处理，未放行时记进面板待允许，配对码只显示成 `••••••`）；`risk.js` 把 `adb pair` 判为 confirm；修正配对工具说明里的语病；固定端口期间状态条显示「正在固定端口…」；host:port 拼接收敛到 `formatHostPort()`，IPv6 地址统一加方括号；`adbConnect` 遇到空目标直接报 `no-target`；`parseMdns` 去掉没有人用的 legacy 分支；README 补充 TLS 与固定端口互斥。
- **1.3.0**：面板新增「固定端口」（`adb tcpip 3455`，仅本次开机有效，需已有传输）；新增 Android 11+ 无线调试配对工具 `adb_pair`（配对码不落盘、mDNS 自动发现连接端口、地址记住后自动重连）；`logcat -f/--file/-r/-n` 写文件归入需同意；README 补固定端口与配对说明。
- **1.2.5**：把 AI 行为边界从「提示词自觉」变成工具层强制：命令分只读 / 需同意 / 红线三级，面板新增「允许一次」「拒绝」，授权 120 秒过期且只对相同参数有效；截图按 PNG 落盘；工具支持 `serial`；`snapshot` 请求去重、adb server 掉线低频自愈；测试改用临时 `DSH_HOME`，无 ADB 通道自动跳过，新增单测与 `npm test`。
- **1.2.4**：新增面向 AI 的 `adb` 工具（结构化参数、自动重连、原生结果卡）；提示词改为「先说再做、系统级或写入操作先征得同意」（见「AI 行为边界」）。
- **1.2.3**：连接成功后注入「主动使用 adb」的系统提示（系统级操作用 adb，不先问用户）；
  保留原有的自动查找端口、自动重连与面板。
- 0.1.0：首个版本，状态条 + 面板 + 自动连接。

## License

MIT
