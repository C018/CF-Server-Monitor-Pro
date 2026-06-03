
# 一键极速部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/a63414262/CF-Server-Monitor-Pro)

## 📸 界面预览

演示站点：https://odd-art-043f.a68561918.workers.dev

已添加支持 alpine 系统挂载探针，已个性化 CSS 设置，已添加网易云外链单曲循环，可通过 CSS 代码实现个性化探针主题实现。

### 1. 前台多节点大盘与 Web3 全局统计 (全新升级)
<img width="3840" height="1738" alt="image" src="https://github.com/user-attachments/assets/0cd9b65a-ff8e-43b2-8a5f-8a3e6e424359" />
<img width="3840" height="1738" alt="image" src="https://github.com/user-attachments/assets/d341b70b-0131-4b3e-aeda-59ae36091c89" />
<img width="3840" height="1738" alt="image" src="https://github.com/user-attachments/assets/9c5283b5-05cc-4fae-9e10-8f70fe81381c" />

### 2. 单节点实时性能折线图
<img width="3840" height="1738" alt="image" src="https://github.com/user-attachments/assets/81ce19c3-7554-4dd1-818a-7ca478d3eb0d" />
<img width="3840" height="1738" alt="image" src="https://github.com/user-attachments/assets/7024bd65-7ec2-4912-8c7a-38af36796cf3" />

### 3. 后台管理与全局设置
<img width="3840" height="1738" alt="image" src="https://github.com/user-attachments/assets/9d4d21de-6f2a-4980-9b0c-c9850f1e1223" />
<img width="3840" height="1738" alt="image" src="https://github.com/user-attachments/assets/d8bdd200-20bb-42dd-83d2-6810a59f03c8" />
<img width="3840" height="1738" alt="image" src="https://github.com/user-attachments/assets/c6989909-0ce7-4cc1-87e6-65d87e4ea48b" />

---

## 🤝 参与贡献 (Contributing)

如果你喜欢这个项目，欢迎提交 Pull Request，或者给个 ⭐ **Star** 支持一下！

# ⚡ CF-Server-Monitor-Pro (Serverless 探针增强版 & Web3 共识网络)

10 台 VPS 以下可以使用 cf 版本轻量部署，10 台 VPS 以上建议使用 docker 部署在免费容器 northflank：[点击访问 Docker 版](https://github.com/a63414262/server-monitor)

基于 Cloudflare Workers 和 D1 数据库构建的轻量级、零成本、高定制化的服务器探针大盘。
完美复刻了商业级探针（如 Nezha）的核心体验，并**跨时代地引入了 Web3 去中心化共识网络机制**，无需额外部署任何服务端 VPS！完全白嫖 Cloudflare 的免费 Serverless 资源。

## ✨ 核心特性

### 🔗 Web3 去中心化共识与资产系统 (🚀 Pro 独占全新升级)
* **去中心化信标节点 (Beacon Nodes)：** 开启后，你的探针面板将作为 P2P 共识网络的权重节点，通过底层的 Gossip 流言协议与全球探针网络无缝对接，打破信息孤岛。
* **全网探针总资产与重力测算 (Gravity Engine)：** 内置多币种汇率换算引擎。系统会根据本站所有 VPS 的配置价格与到期天数，自动折算数字资产总价值（CNY），并将其作为“资产重力”广播至全网。
* **全网权威排名 (Global Ranking)：** 前台实时展示全球信标节点排行榜！节点资产重力越高、VPS 探针数越多，全网排名越靠前。
* **Cycle 财富账本 (Cycle Ledger)：** 内置原生 Web3 状态机引擎，挂载探针即可自动参与“出块挖矿”获取 Cycle 奖励。支持在后台直接发起全网广播的 P2P 资产转账 (Tx)。
* **资产穿透与链上浏览器：** 首页内置透明的「Cycle 财富英雄榜」与「区块浏览器」。支持一键点击钱包地址即可穿透搜索，瞬间查阅任意 EVM 地址的 Cycle 余额与链上流水。
* **V16 Pure Chain 大一统协议：** 底层采用最新的硬分叉哈希验证与缓冲扩容技术，完美解决同高度分叉碰撞。

### 📉 极致的差分采集算法 (省额度神器)
* **探针端边缘过滤：** 彻底告别无脑定时上报！Agent 端内置高精度的动态差分比对算法。只有当 CPU 波动 >10%、内存波动 >5% 或网速突变超过 30% 时，才会触发完整数据上报。
* **微损心跳保活：** 在服务器闲置或数据平稳期间，探针会自动降级为极低负载的 Ping 心跳包。最高可节省 80% 的 Cloudflare Workers 请求数与 D1 数据库写入额度，确保完全不超免费套餐限制。
* **V8 内存级缓存穿透保护：** Worker 端采用 V8 引擎全局内存 (globalThis) 实现了 5000ms 级别的请求限流 (Throttling)，阻断高并发与恶意刷量，完美保护 Serverless 免费额度。

### 🎨 极致的视觉与个性化体验
* **高级自定义 CSS / JS 注入**：支持完全自定义 CSS 主题，支持原生 JS 动态特效注入，轻松实现网易云外链作为背景音乐自动单曲循环播放。
* **国旗智能匹配**：依托 Cloudflare 全球网络，自动识别 VPS 归属地并渲染超清图片国旗。
* **无感 AJAX 热更新**：彻底抛弃传统的 `<meta refresh>`，采用 DOM 局部替换与 V8 内存级缓存穿透技术，数据实时跳动，页面零闪烁。
* **多维视图切换**：内置 卡片 (Card)、表格 (Table)、世界地图 (Map) 和 链上区块 (Block) 四种视图，使用 LocalStorage 自动记忆用户偏好。

### 📊 专业级监控与大盘展示
* **全局顶栏大盘**：直观展示服务器总数、在线/离线数、总计流量（入/出）以及全网实时网速。
* **硬核双栈检测**：自动探测并高亮打标 VPS 的 **IPv4** 与 **IPv6** 网络连通性。
* **商业级自定义徽章**：支持为每台机器单独设置**价格、到期时间（自动计算剩余天数）、带宽上限、流量配额**，并在前台以彩色徽章优雅展示。
* **过去24h至实时详情图表**：点击任意节点卡片，即可查看基于 Chart.js 的 CPU、内存、磁盘、进程数、TCP/UDP 连接数及双向网速的实时折线图，以及三网延迟追踪（电信/联通/移动/字节）。
* **月度流量重置**：内置流量增量累加机制，支持开启每月 1 号自动重置统计，无惧被控端 VPS 重启导致的数据清零。

### 🛡️ 隐私、安全与管理控制
* **Agent 上报频率自定义**：后台支持一键修改全网探针的上报心跳间隔（如 5 秒 / 10 秒）。
* **一键私密模式与节点隐藏**：吃灰神机不想公开？在后台取消勾选“公开访问”即可。同时支持单独隐藏某台具体的 VPS，只在后台可见。
* **模块化展示开关**：价格、到期时间、带宽、流量、甚至是数字资产价值等敏感信息，可在后台一键控制前台展示。

### 🚀 极简部署与高精度采集
* **底层精准脱钩算法**：抛弃传统不稳定的 `top` 命令，采用 Linux 内核级 `/proc/stat` 计算 CPU 时钟差值，数据采集跳动精准顺滑。
* **傻瓜式一键安装**：后台添加节点后自动生成被控端 Bash 安装命令，完美支持 Debian/Ubuntu/CentOS 等 Systemd 架构，同时 **首发支持 Alpine (OpenRC) 轻量系统** 挂载探针！

---

## 🚀 部署指南 (Deployment)

**第一步：配置 Cloudflare 环境**
1. 登录 Cloudflare 控制台，进入 `Workers & Pages`。
2. 创建一个全新的 D1 数据库，命名为 `probe-db`。
3. 创建一个新的 Worker 服务。

**第二步：配置 Worker**
1. 将本项目中的 `worker.js` 代码全部复制并覆盖到你的 Worker 代码编辑器中。
2. 在 Worker 的 **设置 (Settings) -> 变量 (Variables)** 中，绑定你刚才创建的 D1 数据库，变量名称必须为 `DB`。
3. 在环境变量中添加一个密码变量，用于后台登录：
   - 变量名：`API_SECRET`
   - 值：设置你的高强度密码

**第三步：访问与初始化**
部署完成后，访问你的 Worker 域名。
- 管理后台路径：`https://你的域名.workers.dev/admin`
- 账号：`admin`
- 密码：你设置的 `API_SECRET` 的值
*(注意：首次访问会自动初始化 D1 数据表，无需手动建表)*
- **💡 提示**：在后台全局设置中，记得填入你的“出块奖励收款钱包地址 (EVM格式)”，你的节点每次打包新区块都会自动为你发放 Cycle 资产！

---

## 💻 客户端探针安装 (Client Agent)

进入管理后台后，点击 "+ 添加新服务器"。添加完成后，列表中会生成专属的一键安装命令。

直接复制该命令，在你的目标 VPS 上（需 Root 权限）运行即可：
```bash
curl -sL [https://你的域名.workers.dev/install.sh](https://你的域名.workers.dev/install.sh) | bash -s <SERVER_ID> <API_SECRET>

```

*（提示：对于 Alpine 系统，后台会自动生成带 `?os=alpine` 的专属链接，无缝兼容 OpenRC）*

探针脚本会自动注册为系统服务 (`cf-probe.service` 或 `cf-probe`)，并在后台静默运行，根据你后台设定的频率自动上报数据。

---

## 🛠️ 高级自定义特效注入 (Advanced Customization)

本项目为喜欢折腾的开发者预留了最高权限的魔改入口。进入后台 **全局设置 -> 前端主题风格 -> 选择“6. 完全自定义 CSS”**：

* **自定义 CSS**：重写面板的所有样式，支持背景、卡片透明度、字体颜色等。
* ** 注入**：你可以引入外部的 Google Fonts、TailwindCSS CDN 等。
* **Script 注入**：编写原生 JavaScript 接管页面逻辑，比如增加动态粒子背景、甚至通过设置 `body { display: none; }` 隐藏原生页面，利用 AJAX 接口数据用你自己的前端框架重绘大盘。

### ✨ 自定义二次元透明主题 CSS 演示

将以下代码填入后台的 **「自定义 CSS 代码」** 输入框中，即可实现超清动漫壁纸与全站半透明毛玻璃卡片效果：

```css
/* 1. 网页全局背景 */
body.theme6 {
  background: url('[https://i.33xp.cn/__imgapi.cn__/__imgapi.cn__5d19cf2105e31.jpg](https://i.33xp.cn/__imgapi.cn__/__imgapi.cn__5d19cf2105e31.jpg)') no-repeat center center fixed !important;
  background-size: cover !important;
}

/* 2. Canvas 樱花/特效层级提到最高且开启点击穿透 */
#effect_canvas {
    z-index: 99999999 !important;
    pointer-events: none !important;
}

/* 3. 材质重构：改用暗黑系全透明光幕（彻底解决吃字、看不清的问题） */
.theme6 .consensus-panel,
.theme6 .vps-card, 
.theme6 .global-stats, 
.theme6 .custom-table, 
.theme6 .header-card,
.theme6 .custom-table th,
.theme6 .chart-card,
.theme6 .modal-content {
  background: rgba(15, 23, 42, 0.45) !important; /* 优雅的45%半透明深色黑夜底板，压住复杂的背景干扰 */
  backdrop-filter: none !important; /* 保持100%全透明不浑浊 */
  -webkit-backdrop-filter: none !important;
  border: 1px solid rgba(255, 255, 255, 0.15) !important; /* 极细的半透明白描边，勾勒出外框 */
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2) !important; 
  border-radius: 12px !important;
}

/* 4. 荧光控光文字：在暗色背景下，亮色字体清晰度直接暴增 */
.theme6 .c-label,
.theme6 .g-label,
.theme6 .stat-label,
.theme6 .card-meta {
  color: #94a3b8 !important; /* 优雅的浅板岩灰，用于次要标签 */
  font-weight: 500 !important;
  text-shadow: none !important;
}

.theme6 .c-val,
.theme6 .g-val,
.theme6 .stat-val,
.theme6 .card-title-text,
.theme6 .card-title,
.theme6 td {
  color: #f8fafc !important; /* 纯净的月光白，无论背景多复杂都能一眼识别 */
  font-weight: 600 !important;
  text-shadow: none !important; 
}

/* 主标题微调（防止顶部标题看不清） */
.theme6 h1 {
  color: #ffffff !important;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5) !important;
}

/* 5. 进度条背景优化，在暗色下面更加醒目 */
.theme6 .stat-bar-full {
  background: rgba(255, 255, 255, 0.1) !important;
  border: 1px solid rgba(255, 255, 255, 0.05) !important;
}

/* 6. 组件及特殊高亮标签微调 */
.theme6 .badge-bw { background: rgba(59, 130, 246, 0.8) !important; color: #fff !important; }
.theme6 .badge-tf { background: rgba(16, 185, 129, 0.8) !important; color: #fff !important; }
.theme6 span[style*="color:#8b5cf6"], 
.theme6 span[style*="color: rgb(139, 92, 246)"] {
  color: #c084fc !important; /* 改为淡紫色荧光 */
  font-weight: 700 !important;
}

/* 7. 确保点击事件可以传导给 body */
.container {
    position: relative;
    z-index: 10;
}

```

### ✨ 炫酷动态特效注入 (0 依赖纯原生)

如果你喜欢二次元或更加生动的展示界面，可以将以下代码完全复制，并粘贴到管理后台的 **「自定义底部 Script 注入」** 输入框中。这段脚本包含了多种精美的特效，**全部由纯原生 JavaScript 和 Canvas 物理引擎手搓而成，极速渲染且永久有效！**

* 🌸 **樱花飘落**：使用纯数学贝塞尔曲线动态绘制花瓣。
* ✨ **星光拖尾**：随鼠标移动生成的炫彩粒子跟随拖尾。
* ❤️ **爱心浮动**：鼠标点击页面任意位置，生成随机颜色的爱心并上浮。
* 🎵 **背景音乐播放**：实现网易云外链作为背景音乐自动单曲播放（可自行替换音乐 ID）。

```html
<script>
!function() {
    // 1. 动态创建并注入音频标签（防止被 AJAX 刷新洗刷掉）
    if (!document.getElementById('bgm')) {
        var audio = document.createElement('audio');
        audio.id = 'bgm';
        audio.loop = true;
        audio.preload = 'auto';
        audio.style.display = 'none';
        
        var source = document.createElement('source');
        source.src = '[https://music.163.com/song/media/outer/url?id=2614307770.mp3](https://music.163.com/song/media/outer/url?id=2614307770.mp3)';
        source.type = 'audio/mpeg';
        
        audio.appendChild(source);
        document.body.appendChild(audio);
    }

    // 2. 强力捕获级交互播放逻辑（完美解决多图层阻断与点击失效）
    function tryPlayBGM() {
        var bgm = document.getElementById('bgm');
        if (bgm && bgm.paused) {
            bgm.play().then(function() {
                console.log("🎵 BGM 成功通过用户交互触发播放");
                removeAudioListeners();
            }).catch(function(e) {
                console.log("等待更明确的用户交互以允许播放音频...");
            });
        } else {
            removeAudioListeners();
        }
    }

    function removeAudioListeners() {
        window.removeEventListener('click', tryPlayBGM, true);
        window.removeEventListener('touchstart', tryPlayBGM, true);
    }

    // 使用捕获阶段 (true) 拦截监听，确保点击任何探针卡片或地图都能第一时间触发音频
    window.addEventListener('click', tryPlayBGM, true);
    window.addEventListener('touchstart', tryPlayBGM, true);

    // 3. 🌸 纯原生 Canvas 樱花飘落特效
    var canvasSakura = document.createElement("canvas");
    canvasSakura.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;z-index:9999997";
    document.body.appendChild(canvasSakura);
    var ctxS = canvasSakura.getContext("2d"), w = window.innerWidth, h = window.innerHeight;
    canvasSakura.width = w; canvasSakura.height = h;
    window.addEventListener("resize", function(){ w=window.innerWidth; h=window.innerHeight; canvasSakura.width=w; canvasSakura.height=h; });
    var petals = [];
    for(var i=0; i<40; i++) petals.push({ x: Math.random()*w, y: Math.random()*h, vx: Math.random()*0.5+0.5, vy: Math.random()*1+1, angle: Math.random()*Math.PI*2, spin: Math.random()*0.05-0.025, size: Math.random()*4+5 });
    function renderSakura(){
        ctxS.clearRect(0,0,w,h);
        for(var i=0; i<petals.length; i++){
            var p = petals[i];
            ctxS.save(); ctxS.translate(p.x, p.y); ctxS.rotate(p.angle);
            ctxS.beginPath(); ctxS.moveTo(0, -p.size);
            ctxS.bezierCurveTo(p.size, -p.size, p.size, p.size, 0, p.size);
            ctxS.bezierCurveTo(-p.size, p.size, -p.size, -p.size, 0, -p.size);
            ctxS.fillStyle = "rgba(255, 183, 197, 0.7)"; ctxS.fill(); ctxS.restore();
            p.x += p.vx; p.y += p.vy; p.angle += p.spin;
            if(p.y > h || p.x > w) { p.y = -20; p.x = Math.random()*w; }
        }
        requestAnimationFrame(renderSakura);
    }
    renderSakura();

    // 4. ✨ 纯原生 Canvas 鼠标烟花/星光拖尾特效
    var canvasStars = document.createElement("canvas");
    canvasStars.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;z-index:9999998";
    document.body.appendChild(canvasStars);
    var ctxStars = canvasStars.getContext("2d");
    canvasStars.width = w; canvasStars.height = h;
    window.addEventListener("resize", function(){ canvasStars.width=w; canvasStars.height=h; });
    var particles = [], mouse = {x: -100, y: -100};
    window.addEventListener("mousemove", function(e){ 
        mouse.x=e.clientX; mouse.y=e.clientY; 
        particles.push({x:mouse.x, y:mouse.y, vx:Math.random()*2-1, vy:Math.random()*2-1, size:Math.random()*3+1.5, color:"hsl("+(Math.random()*360)+", 100%, 75%)"}); 
    });
    function renderStars(){
        ctxStars.clearRect(0,0,w,h);
        for(var i=0; i<particles.length; i++){
            var p = particles[i];
            ctxStars.beginPath(); ctxStars.arc(p.x, p.y, p.size, 0, Math.PI*2); ctxStars.fillStyle=p.color; ctxStars.fill();
            p.x += p.vx; p.y += p.vy; p.size *= 0.92;
        }
        particles = particles.filter(function(p){ return p.size > 0.5; });
        requestAnimationFrame(renderStars);
    }
    renderStars();

    // 5. ❤️ 纯原生 DOM 鼠标点击爱心上浮特效
    function initHeart(){
        injectStyle(".heart{width: 10px;height: 10px;position: fixed;background: #f00;transform: rotate(45deg);-webkit-transform: rotate(45deg);-moz-transform: rotate(45deg);}.heart:after,.heart:before{content: '';width: inherit;height: inherit;background: inherit;border-radius: 50%;-webkit-border-radius: 50%;-moz-border-radius: 50%;position: fixed;}.heart:after{top: -5px;}.heart:before{left: -5px;}");
        window.addEventListener('click', function(e) {
            var el = document.createElement("div");
            el.className = "heart";
            d.push({el:el, x:e.clientX-5, y:e.clientY-5, scale:1, alpha:1, color:randomColor()});
            document.body.appendChild(el);
        }, true);
        renderHeart();
    }
    var d = [];
    function renderHeart(){
        for(var e=0; e<d.length; e++) {
            if(d[e].alpha<=0){
                document.body.removeChild(d[e].el);
                d.splice(e,1);
            } else {
                d[e].y--; d[e].scale+=.004; d[e].alpha-=.013;
                d[e].el.style.cssText="left:"+d[e].x+"px;top:"+d[e].y+"px;opacity:"+d[e].alpha+";transform:scale("+d[e].scale+","+d[e].scale+") rotate(45deg);background:"+d[e].color+";z-index:9999999";
            }
        }
        requestAnimationFrame(renderHeart);
    }
    function injectStyle(e){
        var a=document.createElement("style"); a.type="text/css";
        try{a.appendChild(document.createTextNode(e))}catch(t){a.styleSheet.cssText=e}
        document.getElementsByTagName("head")[0].appendChild(a);
    }
    function randomColor(){ return "rgb("+~~(255*Math.random())+","+~~(255*Math.random())+","+~~(255*Math.random())+")"; }
    initHeart();
}();
</script>

```

*注：你可以使用 `https://imgapi.cn/api.php?fl=dongman&=4k` 这类 API 接口实现背景图片的自动随机轮换。*

---

## 🔔 Telegram 离线机器人告警设置

1. **获取 Token**：在 Telegram 找 `@BotFather` 创建机器人并拿到 Token。
2. **获取 Chat ID**：在 Telegram 找 `@userinfobot` 发条消息，获取你的 ID。
3. **配置**：
* 登录你的探针后台 `/admin`。
* 在 **Telegram 离线告警设置** 区域，填入 Token 和 Chat ID。
* 将“开启通知”设为 **开启告警**。
* 点击 **保存全局设置**。


4. **测试**：如果你关掉一台 VPS 的 Agent，大约 2-3 分钟内，你的 Telegram 就会收到该节点的离线报警信息。当 Agent 重新启动，也会收到恢复通知。

*(注意事项：离线判断标准代码中设定为 300 秒未收到上报即发送告警。告警状态存储在数据库中，节点掉线只会发一次通知，恢复后再掉线才会触发新告警。)*

---

## ⚙️ 探针卸载 (Uninstall Agent)

如果需要从被控端 VPS 卸载探针服务，请在 VPS 终端（Root权限）执行以下命令：

**Debian/Ubuntu/CentOS (Systemd):**

```bash
systemctl stop cf-probe.service
systemctl disable cf-probe.service
rm /etc/systemd/system/cf-probe.service
rm /usr/local/bin/cf-probe.sh
systemctl daemon-reload

```

**Alpine (OpenRC):**

```bash
rc-service cf-probe stop
rc-update del cf-probe default
rm /etc/init.d/cf-probe
rm /usr/local/bin/cf-probe.sh

```

---

## 📊 资源消耗精算：为何这是零成本白嫖的首选？

为了精准测算挂载 10 台 VPS 时，使用该版本代码中高精差分上报算法与传统定时上报探针的 Workers 请求额度及数据库消耗对比，我们可以基于代码中设定的运行逻辑进行量化数学推导。

### 核心变量与参数设定

根据 `cf-probe.sh` 客户端脚本和 Worker 逻辑，提取以下核心运行参数：

* **常规上报间隔 (REPORT_INTERVAL)**：默认 40 秒。
* **心跳保活间隔 (HEARTBEAT_INTERVAL)**：固定 120 秒。
* **本地循环探测频率**：每 3 秒执行一次本地数据采集。
* **静态配置同步间隔**：每 15 秒执行一次 `config.json` 获取（用于秒级热重载）。
* **差分触发阈值**：
* CPU 变动 > 10% 或 内存变动 > 5% 或 存储变动 > 1%
* 网速突变 > 30%（且速率变化大于 300KB/s）
* IPv4/IPv6 双栈连通性发生切换



### 🔍 两类经典运行场景测算

我们将 10 台 VPS 的状态分为两个极端场景来进行全天（24小时）的额度消耗精算。

**场景 A：纯吃灰/极度闲置（如 10 台 VPS 均无业务，平稳运行）**
在此状态下，由于系统各项 Metrics 的波动无法达到差分阈值，客户端探针将完全不会触发常规上报，而是自动降级到微损心跳模式。

* **心跳保活请求 (type: ping)**：10 台 × (86400 秒 / 120 秒/次) = 7,200 次/天
* **热重载配置请求 (config.json)**：10 台 × (86400 秒 / 15 秒/次) = 57,600 次/天
*(注：此请求在 Worker 端设置了高强度的浏览器/CDN 缓存 `public, max-age=5`。大部分请求会在边缘节点直接命中返回，真正穿透到 Worker 的请求数会进一步削减。此处按最坏打算穿透计算)*
* **场景 A 全天总请求数**：7,200 + 57,600 = 64,800 次/天
* **场景 A D1 数据库写入 (UPDATE) 频率**：仅在 ping 时更新 `last_updated` 时间戳，全天共 7,200 次。

**场景 B：高频生产业务（如 10 台 VPS 均运行高并发项目，数据剧烈跳动）**
在此状态下，由于数据频繁跨越阈值，几乎每次循环探测都会触发完整上报，保活心跳自动失效（0次）。

* **差分完整上报请求 (/update)**：10 台 × (86400 秒 / 40 秒/次) = 21,600 次/天
* **热重载配置请求 (config.json)**：10 台 × (86400 秒 / 15 秒/次) = 57,600 次/天
* **场景 B 全天总请求数**：21,600 + 57,600 = 79,200 次/天
* **场景 B D1 数据库写入 (UPDATE/INSERT) 频率**：每次完整 Metrics 上报均会写入 D1，全天共 21,600 次。

### ⚖️ 差分探针 VS 传统探针 消耗量对比大盘

引入传统探针（无差分，固定 5 秒/次无脑上报，无静态配置缓存）进行对比。假设日常综合情况为：15% 的时间处于波动触发状态（场景 B），85% 的时间处于平稳保活状态（场景 A）。

| 指标维度 | 传统高频定时监控面板 (5秒固定上报) | ⚡ CF-Server-Monitor-Pro (差分方案) | 节省与优化率 | Cloudflare 免费额度水位线 |
| --- | --- | --- | --- | --- |
| **Workers 每日总请求数** | 172,800 次 | 66,960 次 (加权平均) | **降低 61.2%** | 100,000 次/天 (完美不超标) |
| **D1 数据库每日写入次数** | 172,800 次 | 9,360 次 (加权平均) | **降低 94.5%** | 100,000 次/天 (极度安全) |
| **Web3 全网 Gossip 广播数** | 频繁广播导致 CPU 穿透限制 | 5000ms 动态 Bucket 锁自动限流 | **降低 90% 以上** | 毫秒级 CPU 耗时缓冲 |
| **网页前台多用户刷新负载** | 每次刷新直接穿透 D1 读库 | AJAX 时间桶内存锁 (globalThis) | **99% 穿透保护** | 内存级毫秒级穿透保护 |

### 💡 总结与部署建议

通过以上量化算力测算，可以得出确定性结论：**挂载 10 台 VPS 是这套 Worker 架构在 Cloudflare 免费版（Free Plan）套餐下运行的最完美的“黄金分水岭”。**

因为在综合负载下，每天 6.6 万次左右的 Workers 请求数刚好被死死压在 Cloudflare 免费额度 10 万次/天的安全线以内。更惊艳的是，得益于客户端本地计算的差分算法，D1 数据库的写入量直接从 17 万次暴跌到 9000 次左右，完全不需要担心触及 D1 的免费写入天花板，真正实现了长期、稳定、零成本的永久白嫖。

---

## 📄 License

MIT License

```

```
