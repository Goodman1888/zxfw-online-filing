/**
 * 人民法院在线服务网 —— 网上立案自动化（民事一审 / 保险人代位求偿权纠纷）
 *
 * 当前覆盖：第 1~4 步（选受理法院 → 阅读须知 → 选立案案由 → 上传诉讼材料）
 * 停在「完善案件信息」，由人工继续。最终提交永远人工点。
 *
 * 用法：
 *   node filing.js /path/to/case-dir --court 定远县人民法院
 *   node filing.js <案件目录> --court <法院全称> [--cause 保险人代位求偿权纠纷] [--headless]
 *
 * 首次运行需要扫码登录，登录态保存在 ./.chrome-profile，之后免登录。
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 必须从这个入口进：直接用 URL 跳向导页会跳过主站初始化，
// 地区/法院字典不加载，第 1 步的省份下拉会是「无选项」。
const ENTRY_URL = 'https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/zxla/pick-case-type/index';

const PROFILE_DIR = path.join(__dirname, '.chrome-profile');

function acquireProfileSession(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  const occupied = pid => new Error(`法院登录配置正在被进程 ${pid} 使用，请等该案件完成并关闭浏览器后再继续；不会自动终止其他会话。`);
  const chromeLock = path.join(profileDir, 'SingletonLock');
  try {
    const match = fs.readlinkSync(chromeLock).match(/-(\d+)$/);
    if (match && alive(Number(match[1]))) throw occupied(match[1]);
  } catch (e) { if (!['ENOENT', 'EINVAL'].includes(e.code)) throw e; }
  const scriptLock = path.join(profileDir, 'filing-session.lock');
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = fs.openSync(scriptLock, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(scriptLock, 'utf8')); }
      catch { throw new Error('登录配置锁信息尚未写完或无法读取，请稍后重试；不会删除不明锁。'); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid)) throw occupied(owner.pid || '未知');
      throw new Error(`上次脚本进程 ${owner.pid} 已退出，但登录配置仍留有 ${scriptLock}；请确认没有浏览器使用该配置后再清理该锁。`);
    }
  }
  if (fd === undefined) throw new Error('登录配置锁争用，请稍后重试');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  fs.closeSync(fd);
  const release = () => {
    try { if (JSON.parse(fs.readFileSync(scriptLock, 'utf8')).pid === process.pid) fs.unlinkSync(scriptLock); } catch {}
  };
  process.once('exit', release);
  return release;
}


// 材料槽位 → 文件名匹配规则。顺序即上传顺序。
// 证据目录已并入证据材料，独立的「证据目录」文件一律不传。
// all: true 表示这个槽位收目录里**所有**匹配的文件，不是只取第一个。
// 当事人身份证明必须覆盖全部当事人：被告的身份证明 + 各组织被告的企查查工商信息，
// 原告那份从常用材料库引入（见第 4c 步）。
const SLOTS = [
  { slot: '起诉状',                       match: /起诉状/ },
  // 「身份信息」也要认：户籍摘抄有时按这个名字存（车干君案），漏了就整个槽位空着。
  // 「营业执照」是组织当事人的主体资格材料（其他保险公司无锡三件套那种），也归这个槽位。
  // 「人口信息查询结果告知书」是公安出的标准件，查不到被告身份信息时就靠它，
  // 用途等同身份证明（龚建清案漏了它，槽位里只剩原告材料）。
  { slot: '当事人身份证明',               match: /身份证明|身份信息|人口信息|企查查|营业执照/, all: true },
  // 委托手续有时不是一份合订件，而是拆成「授权委托书」+「公函」两个文件（其他保险公司无锡案），
  // 两份都要传，所以这里也要 all: true。
  { slot: '委托代理人委托手续和身份材料', match: /委托手续|授权委托书|公函/, all: true },
  { slot: '证据目录及证据材料',           match: /证据材料/ },
  // 默认由平台「引入送达地址确认书」生成（第 4b 步）。目录里放了签好字的纸质版
  // （文件名「地址.pdf」「地址送达确认书*.pdf」）就直接上传、不再引入 ——
  // 莫长标案 2026-09-22 用户要求。没有这份文件就照老路生成，不告警。
  { slot: '送达地址确认书', match: /地址送达确认书|送达地址确认书|^地址(\.pdf$|[_（(])/, optional: true, quiet: true },
  { slot: '其他',           match: /调查令/, all: true, optional: true, quiet: true },
];

function parseArgs(argv) {
  const args = {
    dir: null, court: null, province: null, city: null,
    resume: null, fyid: null, cleanup: false,
    plaintiffCert: null, certs: null,
    cause: '保险人代位求偿权纠纷', headless: false, allowMissingId: false,
    // yishen = 民事一审（默认）；zhixing = 申请执行
    type: 'yishen', casenum: null, goto: null,
    // 传谁的执业证，取决于授权委托书/公函里委托了谁（扫描件无文字层，只能由调用方指定）
    lawyers: ['张律师'],
  };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--court') args.court = argv[++i];
    else if (a === '--province') args.province = argv[++i];
    else if (a === '--city') args.city = argv[++i];
    else if (a === '--lawyers') args.lawyers = argv[++i].split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    // 常用材料库里那两条的名字。原告不是示例保险、或者代理人组合不是张律师/李律师时，
    // 用这两个参数直接指名，绕开下面写死的映射（某保险分公司 + 张律师、王律师就是这么跑的）。
    else if (a === '--plaintiff-cert') args.plaintiffCert = argv[++i];
    else if (a === '--certs') args.certs = argv[++i].split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    else if (a === '--resume') args.resume = argv[++i];        // 草稿 layyid，或直接粘浏览器地址栏那条 URL
    else if (a === '--fyid') args.fyid = argv[++i];
    else if (a === '--cause') args.cause = argv[++i];
    else if (a === '--headless') args.headless = true;
    else if (a === '--allow-missing-id') args.allowMissingId = true;
    else if (a === '--cleanup') args.cleanup = true;
    else if (a === '--zhixing') args.type = 'zhixing';
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--casenum') args.casenum = argv[++i];
    else if (a === '--goto') args.goto = argv[++i];   // 直接打开一条停在半路的向导 URL
    else rest.push(a);
  }
  args.dir = rest[0];
  const resumeUrl = args.resume || args.goto;
  if (resumeUrl && /^https?:\/\//.test(resumeUrl)) {
    const query = new URLSearchParams(resumeUrl.split('?').slice(1).join('?'));
    if (query.get('ajlx') === '1501_000001-1002' || query.get('ajcx') === 'zx') args.type = 'zhixing';
    else if (args.type === 'zhixing' && query.get('ajlx') === '1501_000001-0301') {
      throw new Error('申请执行续跑地址却是民事一审，请提供完整执行草稿地址');
    }
  }
  return args;
}

/**
 * uni-app 的 placeholder 是独立的 div，不是 input 的 placeholder 属性，
 * getByPlaceholder 找不到。两种写法都试。
 */
function inputByPlaceholder(page, text) {
  return page
    .locator(
      `xpath=//input[@placeholder=${JSON.stringify(text)}]` +
      ` | //*[normalize-space(text())=${JSON.stringify(text)}]/following::input[1]`
    )
    .first();
}

/** 按规则把目录里的 PDF 映射到材料槽位 */
function resolveFiles(dir, slots = SLOTS) {
  const pdfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  const resolved = [];
  const missing = [];
  const missingOptional = [];
  const used = new Set();
  for (const { slot, match, all, optional, quiet } of slots) {
    const hits = pdfs.filter((f) => match.test(f));
    if (!hits.length) {
      if (!quiet) (optional ? missingOptional : missing).push(slot);
      continue;
    }
    const picked = all ? hits : [hits[0]];
    picked.forEach((f) => used.add(f));
    resolved.push({ slot, files: picked.map((f) => path.join(dir, f)) });
  }
  // 一条规则都没命中的 PDF：多半是命名不合套路的必传件，漏掉平台也不会提醒。
  // 另一示例案件的「[15153337]范帆_sign.pdf」（负责人身份证复印件）就是这么漏掉的，
  // 所以这里必须吵一声，让人当场决定要不要改名/手工补传。
  const unmatched = pdfs.filter((f) => !used.has(f));
  return { resolved, missing, missingOptional, pdfs, unmatched };
}

const log = (...a) => console.log('▸', ...a);
const warn = (...a) => console.log('⚠', ...a);

/**
 * uni-app 经常把同一段文字渲染成多份（PC/移动两套模板、picker 的隐藏项）。
 * 直接 .first()/.last() 会点到不可见的那份，必须挑第一个真正可见的。
 */
async function clickText(page, text, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const all = page.locator(`text="${text}"`);
    const n = await all.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = all.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 5000 }).catch(() => {});
        return true;
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`点不到「${text}」：元素不存在或全部不可见`);
}

/** 模糊匹配文字（按钮上带「+」等前缀时用），点第一个可见的 */
async function clickTextLoose(page, text, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const all = page.locator(`text=${text}`);
    const n = await all.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = all.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 5000 }).catch(() => {});
        return true;
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`点不到「${text}」：元素不存在或全部不可见`);
}

/**
 * 按条件找元素并用鼠标点它的中心。
 * uni-app 的很多控件对 el.click() 不响应，必须真的派发鼠标事件。
 */
async function clickWhere(page, pageFn, desc) {
  const box = await page.evaluate(pageFn);
  if (!box) throw new Error(`找不到${desc}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** 存在且可见就点，不存在也不报错 */
async function clickTextIfVisible(page, text) {
  const all = page.locator(`text="${text}"`);
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** 关掉可能出现的推广/提示弹窗，返回是否关掉了什么 */
async function dismissPopups(page) {
  const buttons = ['关闭', '不选择要素式立案', '不体验智能识别要素式立案服务'];
  let acted = false;
  for (const label of buttons) {
    if (await clickTextIfVisible(page, label)) {
      acted = true;
      await page.waitForTimeout(500);
    }
  }
  return acted;
}

async function ensureLoggedIn(page) {
  await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  let token = await page.evaluate(() => !!localStorage.getItem('zxfwtoken'));
  if (!token) {
    warn('未登录 —— 请在弹出的浏览器里完成扫码登录，登录后脚本会自动继续（最多等 5 分钟）');
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && !token) {
      await page.waitForTimeout(3000);
      token = await page.evaluate(() => !!localStorage.getItem('zxfwtoken'));
    }
    if (!token) throw new Error('登录超时');
    log('登录成功');
    await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }

  const who = await page.evaluate(() => localStorage.getItem('username') || '');
  log(`已登录：${who}`);
}

/**
 * 续跑一条已存在的草稿：直接打开它的向导页，从当前所在步骤往下走。
 * `--resume` 可以给 layyid，也可以直接粘浏览器地址栏那条完整 URL（里面 fyid 等参数都全）。
 */
function buildResumeUrl(resume, fyid, type = 'yishen') {
  if (/^https?:\/\//.test(resume)) return resume;
  if (!fyid) throw new Error('--resume 给的是 layyid 时，必须同时用 --fyid 指定法院代码；或者直接粘完整 URL');
  const execution = type === 'zhixing';
  const ajlx = execution ? '1501_000001-1002' : '1501_000001-0301';
  const ajcx = execution ? 'zx' : 'sp';
  const param = encodeURIComponent(JSON.stringify({ id: resume, ajlx, fyid: String(fyid), ajcx, lafs: execution ? null : 2 }));
  return 'https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/index' +
    `?step=${execution ? 2 : 3}&layyid=${resume}&ajlx=${ajlx}&fyid=${fyid}&ajcx=${ajcx}` +
    `&layyParam=${param}&ajlxMc=${encodeURIComponent(execution ? '首次执行案件' : '民事一审案件')}`;
}

/** 打开草稿并判断它当前停在哪一步 */
async function openDraft(page, url) {
  log('打开已有草稿续跑');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  for (let i = 0; i < 3; i++) {
    if (await page.getByText('提交', { exact: true }).isVisible().catch(() => false)) return '预览和提交';
    if (await page.locator('text=标的信息').first().isVisible().catch(() => false) ||
        await page.locator('text=申请执行人信息').first().isVisible().catch(() => false)) return '完善案件信息';
    if (await page.locator('text=材料信息').first().isVisible().catch(() => false)) return '上传诉讼材料';
    await page.waitForTimeout(2500);
  }
  throw new Error('打开草稿后认不出当前步骤，页面可能没加载完');
}

/**
 * 盯住建草稿接口的响应，把新草稿的 layyid 记在 page 上。
 * POST /api/v3/layy 的返回体 data 就是新草稿 id。
 */
function captureLayyid(page) {
  page.on('response', async (res) => {
    try {
      const req = res.request();
      if (req.method() !== 'POST') return;
      if (!/\/api\/v3\/layy$/.test(new URL(res.url()).pathname)) return;
      const j = await res.json();
      if (j && typeof j.data === 'string' && /^[a-f0-9]{32}$/.test(j.data)) {
        page.__layyid = j.data;
      }
      // 顺手把 fyid 也记下来：续跑要 `--resume <layyid> --fyid <法院代码>`，
      // 而 fyid 只存在于这个建草稿请求里（列表接口也能取，但要多开一次浏览器）。
      // 请求体里那个 fyid 就是后面要用的法院代码（李虎案 2026-01-05 加的）。
      try {
        const body = req.postDataJSON();
        const fy = body && (body.fyid || body.fyId || (body.data && (body.data.fyid || body.data.fyId)));
        if (fy) page.__fyid = String(fy);
      } catch (e) {}
    } catch (e) {}
  });
}

/**
 * 清理「我的立案」里的空草稿（调试或中途失败会留下一堆）。
 *
 * 只删「待提交 + 名称暂无」的 —— 名称是平台在存完当事人后自动拼的，
 * 所以「名称暂无」等价于「连当事人都没录进去的空壳」。
 * 待审核 / 已立案 / 审核不通过 一律不碰。
 */
async function cleanupDrafts(page) {
  log('清理空草稿（只删「待提交 + 名称暂无」）');
  await page.goto('https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(5000);

  let removed = 0;
  for (let round = 1; round <= 30; round++) {
    const target = await page.evaluate(() => {
      const vis = (e) => {
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };
      const title = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length === 0 && e.textContent.trim() === '名称暂无' && vis(e)
      );
      if (!title) return null;
      // 顺带把这一行的法院名捞出来，便于核对删了什么
      const ty = title.getBoundingClientRect().top;
      const court = Array.from(document.querySelectorAll('*'))
        .filter((e) => e.children.length === 0 && vis(e) && /人民法院$/.test(e.textContent.trim()))
        .map((e) => ({ t: e.textContent.trim(), gap: e.getBoundingClientRect().top - ty }))
        .filter((o) => o.gap > 0 && o.gap < 200)
        .sort((a, b) => a.gap - b.gap)[0];
      return { court: court ? court.t : '(法院未知)' };
    });

    if (!target) break;

    await clickRowButton(page, '名称暂无', '删除');
    await page.waitForTimeout(1200);
    // 确认弹窗的按钮是「OK」（平台用的原生风格文案），保险起见两种都试
    if (!(await clickTextIfVisible(page, 'OK'))) await clickTextIfVisible(page, '确定');
    await page.waitForTimeout(2500);

    removed++;
    log(`  已删除第 ${removed} 条：${target.court}`);
  }

  log(removed ? `共删除 ${removed} 条空草稿` : '没有空草稿需要清理');
}

/** 从「选择案件类型」点进民事一审，向导在新标签页打开 */
async function openWizard(context, page, card = '民事一审') {
  log(`打开${card}向导`);
  await page.locator('text="选择案件类型"').first().waitFor({ timeout: 20000 });

  const [wizard] = await Promise.all([
    context.waitForEvent('page', { timeout: 20000 }),
    clickText(page, card),
  ]);
  await wizard.waitForLoadState('domcontentloaded');
  await wizard.waitForTimeout(3000);
  await wizard.setViewportSize({ width: 1440, height: 900 });

  await wizard.locator('text="选择受理法院"').first().waitFor({ timeout: 20000 });
  captureLayyid(wizard);
  return wizard;
}

/**
 * 打开省份下拉。不依赖类名也不依赖它当前显示的文字（配置目录会记住上次选的省），
 * 而是用搜索框的位置反推：省份框就在搜索框左边、同一行。
 */
async function openProvincePicker(page) {
  const box = await inputByPlaceholder(page, '请输入搜索关键词').boundingBox();
  if (!box) throw new Error('找不到搜索框，无法定位省份下拉');
  await page.mouse.click(box.x - 100, box.y + box.height / 2);
  await page.waitForTimeout(900);
}

/**
 * 判断省份是否已经选中。
 *
 * 不读下拉框本身的文字——下拉浮层没关时 elementFromPoint 会读到浮层里的选项，
 * 明明选对了也会判成失败（实测在浙江省上误判并空转四轮）。
 * 改看市级 tab 行：省份一旦生效，tab 行第一个就是该省名。
 */
async function isProvinceSelected(page, province) {
  return page
    .evaluate((prov) => {
      const vis = (e) => {
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };
      // 「法院」标题下方那一行 tab，第一个是省名
      const tabs = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && vis(e) && e.textContent.trim() === prov
      );
      return tabs.some((t) => {
        const r = t.getBoundingClientRect();
        return r.top > 350 && r.top < 520; // tab 行的大致位置，排除下拉浮层里的同名项
      });
    }, province)
    .catch(() => false);
}

/**
 * 选省份。uni-app 的 picker 点击会先滚动再落选，容易差一位，
 * 所以必须选完回读校验，不对就重试。
 * 注意：配置目录会记住上次选的省，下拉框显示的不一定是「请选择」。
 */
async function selectProvince(page, province) {
  // 可能上一轮已经选好了（配置目录会记住），先看一眼免得白折腾
  if (await isProvinceSelected(page, province)) {
    log(`  省份已是：${province}`);
    return;
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    await openProvincePicker(page);

    const item = page
      .locator('.uni-picker-item, [class*="picker-item"], li, div')
      .filter({ hasText: new RegExp(`^\\s*${province}\\s*$`) })
      .first();

    if (await item.isVisible().catch(() => false)) {
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400); // 等滚动停稳再点，否则会点到邻项
      await item.click({ timeout: 5000 }).catch(() => {});
    } else {
      await clickText(page, province).catch(() => {});
    }
    // 选完把下拉关掉再校验，否则浮层会挡住判断
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1500);

    if (await isProvinceSelected(page, province)) {
      log(`  省份已选中：${province}`);
      return;
    }
    warn(`  省份没选中，重试 ${attempt}/4`);
  }
  throw new Error(`省份选择失败，始终选不中「${province}」`);
}

/** 第 1 步：选受理法院 + 申请人类型 */
async function step1SelectCourt(page, courtName, province, city) {
  log(`第1步 选受理法院：${courtName}`);

  if (!province) throw new Error('必须用 --province 指定省份（例：--province 安徽省）');
  log(`  先选省份：${province}`);
  await selectProvince(page, province);

  // 市级 tab（法院按钮只在选中市之后才出现）。
  // 直辖市（北京/上海/天津/重庆）没有市级 tab 行，法院直接列在省下面；
  // 这时候去点「某直辖市」会点到省份下拉框本身，把下拉重新打开并盖住法院列表。
  const 直辖市 = ['北京市', '某直辖市', '天津市', '重庆市'];
  if (city && city !== province && !直辖市.includes(province)) {
    log(`  选市：${city}`);
    await clickText(page, city);
    await page.waitForTimeout(1500);
  } else if (直辖市.includes(province)) {
    log('  直辖市，无市级 tab，跳过');
  }

  // 法院按钮在网格里，直接点全称。
  // 网格是选完市之后异步拉回来的，慢的时候要好几秒。原来只等 1.5 秒就判定「没找到」，
  // 于是掉进搜索兜底——而搜索这条路本身不稳（点完搜索市级 tab 会退回省级、
  // 或者省份下拉被重新掀开盖住结果），张家文、泮鱼完都是这么挂的。先耐心等网格。
  let picked = false;
  const gridDeadline = Date.now() + 15000;
  while (Date.now() < gridDeadline) {
    if (await clickTextIfVisible(page, courtName)) { picked = true; break; }
    await page.waitForTimeout(1000);
  }

  // 网格里没直接命中：先把这个市下面到底有哪些法院列出来。
  // 一旦动了搜索，市级 tab 会被重置、网格清空，就再也看不到这张表了（巴建岭案栽在这）。
  let gridCourts = [];
  if (!picked) {
    gridCourts = await page.evaluate(() => {
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return [...new Set(Array.from(document.querySelectorAll('*'))
        .filter((e) => e.children.length === 0 && vis(e) && /人民法院$/.test(e.textContent.trim()))
        .map((e) => e.textContent.trim()))];
    }).catch(() => []);
    if (gridCourts.length) warn(`  网格里这个市下面共 ${gridCourts.length} 家：${gridCourts.join('、')}`);
  }

  // 平台上的法院名和材料上写的常差几个字（公函写「洛阳市洛宁县人民法院」，
  // 平台可能只写「洛宁县人民法院」；莆田荔城那件反过来，材料多了个省名）。
  // 精确匹配不中就按核心名（去掉省/市前缀）在网格里找一个包含它的，
  // 点中了会把平台的原名打出来，核对一眼即可 —— 别为几个字白跑一轮。
  if (!picked) {
    const core = courtName.replace(/^.*?省/, '').replace(/^.*?(市|自治州|地区)(?=.*人民法院)/, '');
    if (core && core !== courtName) {
      const got = await page.evaluate((c) => {
        const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        document.querySelectorAll('[data-court]').forEach((e) => e.removeAttribute('data-court'));
        const el = Array.from(document.querySelectorAll('*')).find(
          (e) => e.children.length === 0 && vis(e) && /人民法院$/.test(e.textContent.trim()) &&
                 (e.textContent.trim().includes(c) || c.includes(e.textContent.trim()))
        );
        if (!el) return null;
        el.setAttribute('data-court', '1');
        return el.textContent.trim();
      }, core);
      if (got) {
        await page.locator('[data-court="1"]').click({ timeout: 8000 }).catch(() => {});
        picked = true;
        warn(`  精确名没匹配上，网格里按「${core}」找到并点了「${got}」—— 核对一下是不是这家`);
      }
    }
  }

  if (!picked) {
    // 搜索用全称经常「暂无数据」—— 平台上的写法和材料上差几个字（开发区法院尤其乱）。
    // 逐级缩短关键词再搜：全称 → 去掉「人民法院」→ 去掉省市前缀后的核心名。
    const queries = [...new Set([
      courtName,
      courtName.replace(/人民法院$/, ''),
      courtName.replace(/^.*?省/, '').replace(/^.*?市(?=.)/, '').replace(/人民法院$/, ''),
    ].filter((q) => q && q.length >= 2))];

    for (const q of queries) {
      if (picked) break;
      warn(`  网格里没找到，用「${q}」搜索`);
      await inputByPlaceholder(page, '请输入搜索关键词').fill(q);
      await clickText(page, '搜索');
      for (let i = 0; i < 4 && !picked; i++) {
        await page.waitForTimeout(1500);
        if (await clickTextIfVisible(page, courtName)) { picked = true; break; }
        // 搜出来的名字可能和传进来的差几个字，取第一个包含关键词的法院
        const got = await page.evaluate((kw) => {
          const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
          document.querySelectorAll('[data-court]').forEach((e) => e.removeAttribute('data-court'));
          const el = Array.from(document.querySelectorAll('*')).find(
            (e) => e.children.length === 0 && vis(e) && /人民法院$/.test(e.textContent.trim()) &&
                   e.textContent.trim().includes(kw)
          );
          if (!el) return null;
          el.setAttribute('data-court', '1');
          return el.textContent.trim();
        }, q);
        if (got) {
          await page.locator('[data-court="1"]').click({ timeout: 8000 }).catch(() => {});
          picked = true;
          warn(`  搜到并点了「${got}」—— 和材料上写的「${courtName}」不完全一致，核对一下`);
          break;
        }
      }
    }

    if (!picked) {
      const courts = await page.evaluate(() => {
        const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        return [...new Set(Array.from(document.querySelectorAll('*'))
          .filter((e) => e.children.length === 0 && vis(e) && /人民法院$/.test(e.textContent.trim()))
          .map((e) => e.textContent.trim()))];
      }).catch(() => []);
      throw new Error(
        `选不中法院「${courtName}」：网格和搜索都没找到。` +
        (gridCourts.length
          ? `这个市下面只有这些：${gridCourts.join('、')}`
          : courts.length
            ? `当前页面上的法院：${courts.join('、')}`
            : '当前页面上一个法院都没列出来（可能没选中市级 tab）')
      );
    }
  }
  await page.waitForTimeout(1200);

  await dismissPopups(page); // 选完法院可能弹「综治中心」

  log('  申请人类型：为他人或公司等组织申请');
  await clickText(page, '为他人或公司等组织申请');
  await page.waitForTimeout(600);

  await clickText(page, '下一步');
  await page.waitForTimeout(2000);
}

/** 第 2 步：阅读须知 + 立案方式 */
async function step2Notice(page) {
  log('第2步 阅读须知（已获授权自动勾选）');

  // 「综治中心」那类推广弹层会盖住整页，勾选框点不到（泮鱼完案栽在这）。
  // 它可能在第 1 步就弹出来、也可能进了本页才弹，所以先清一遍、点不到再清一次。
  for (let i = 0; i < 3; i++) {
    if (!(await dismissPopups(page))) break;
    await page.waitForTimeout(600);
  }

  try {
    await clickText(page, '已阅读同意立案须知内容', { timeout: 8000 });
  } catch (e) {
    warn('  勾选框点不到，可能有弹层挡着，清一次再试');
    await dismissPopups(page);
    await page.waitForTimeout(1000);
    await clickText(page, '已阅读同意立案须知内容');
  }
  await page.waitForTimeout(500);

  await clickText(page, '下一步');
  await page.waitForTimeout(1500);

  // 可能连弹两层「要素式立案」，都选不使用
  for (let i = 0; i < 3; i++) {
    if (!(await dismissPopups(page))) break;
  }

  log('  立案方式：已准备诉状');
  await clickText(page, '已准备诉状');

  // 服务端在这一步生成草稿。平台忙的时候要十几秒，页面上一直转「加载中」。
  // 原来固定睡 2.5 秒，慢一点就整轮踩空：layyid 抓不到、案由页的「请选择」还没渲染，
  // 报出来的却是「点不到请选择」这种看不出真因的错（泮鱼完案连挂两轮）。
  // 判据只能看「请选择立案方式」这张卡片页有没有消失。
  // 千万别拿宽松的「请选择」当判据 —— 本页标题就叫「请选择立案方式」，一比就命中，
  // 于是刚点完就以为建好了草稿，后面步步踩空（徐国虎案）。
  // 另外这张卡片有时第一下点不上（点中的是卡片里的说明文字），所以隔一会儿补点一次。
  const stillOnPick = () =>
    page.locator('text=请选择立案方式').first().isVisible().catch(() => false);

  const deadline = Date.now() + 60000;
  let ready = false;
  let retried = 0;
  while (Date.now() < deadline) {
    if (page.__layyid) { ready = true; break; }
    if (!(await stillOnPick())) { ready = true; break; }
    await page.waitForTimeout(1500);
    // 还停在选择页 → 补点一次「已准备诉状」，最多补 3 次
    if (retried < 3 && (Date.now() - deadline + 60000) > (retried + 1) * 8000) {
      retried++;
      warn(`  还停在「请选择立案方式」，补点一次（第 ${retried} 次）`);
      await clickText(page, '已准备诉状', { timeout: 8000 }).catch(() => {});
    }
  }
  if (!ready) warn('  等草稿生成超过 60 秒，页面可能还卡在选择立案方式或「加载中」');
  await page.waitForTimeout(1500);

  // 草稿 id 从建草稿接口的响应里取。
  // 不能从地址栏取——这个 SPA 建完草稿后 URL 里并没有 layyid。
  if (page.__layyid) log(`  草稿已建 layyid=${page.__layyid}${page.__fyid ? ` fyid=${page.__fyid}` : ''}`);
  else warn('  没抓到 layyid，中途失败的话只能重跑');
}

/** 第 3 步：选立案案由 */
async function step3Cause(page, cause) {
  log(`第3步 选立案案由：${cause}`);

  await clickText(page, '请选择');
  await page.waitForTimeout(800);

  await inputByPlaceholder(page, '搜索关键词').fill(cause.replace(/纠纷$/, ''));
  await page.waitForTimeout(1200);

  await clickText(page, cause);
  await page.waitForTimeout(700);

  await clickText(page, '下一步');
  await page.waitForTimeout(2500);
}

/** 第 4 步：上传材料。上传框是 uni-app 动态创建的，靠 filechooser 事件接管 */
/**
 * 等平台那个「加载中」遮罩消失。
 * 它是个盖住整页的浮层，点击会被它吃掉、还不报错 —— 表现成
 * 「waitForEvent filechooser 超时」，看错误信息完全猜不到真因。
 * 一个槽位传多份文件时（授权委托书+公函）尤其慢，段晋林案就栽在这。
 */
async function waitForLoading(page, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const busy = await page
      .evaluate(() => {
        const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        return Array.from(document.querySelectorAll('*')).some(
          (e) => e.children.length === 0 && vis(e) && /^加载中/.test(e.textContent.trim())
        );
      })
      .catch(() => false);
    if (!busy) return true;
    await page.waitForTimeout(500);
  }
  warn('  「加载中」超过 90 秒还没消失，继续往下试');
  return false;
}

async function step4Upload(page, files) {
  log('第4步 上传诉讼材料');

  for (const { slot, files: slotFiles } of files) {
    await waitForLoading(page);
    // 「+」是 uni-view.fd-btn-add，每个槽位标题下方紧跟一个。
    // 按「标题下方最近的那个」定位，比按下标取更耐版面变化。
    const idx = await page.evaluate((slotName) => {
      const names = slotName === '其他' ? ['其他', '其他材料', '其他诉讼材料'] : [slotName];
      const title = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length === 0 && names.includes(e.textContent.trim())
      );
      if (!title) return -1;
      const ty = title.getBoundingClientRect().top;
      const adds = Array.from(document.querySelectorAll('.fd-btn-add'));
      let best = -1;
      let bestGap = Infinity;
      adds.forEach((el, i) => {
        const gap = el.getBoundingClientRect().top - ty;
        if (gap > 0 && gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      });
      return best;
    }, slot);

    if (idx < 0) {
      if (slot === '送达地址确认书') {
        warn(`  「${slot}」这一格没有上传按钮（平台可能只允许「引入」），${slotFiles.map((f) => path.basename(f)).join('、')} 请人工上传`);
        continue;
      }
      throw new Error(`材料页找不到槽位「${slot}」的上传按钮`);
    }

    const plus = page.locator('.fd-btn-add').nth(idx);
    await plus.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 20000 }),
      plus.click(),
    ]);
    // 上传框是 multiple 的，一次可以塞多份（当事人身份证明要覆盖全部当事人）
    await chooser.setFiles(slotFiles);

    log(`  ${slot} ← ${slotFiles.map((f) => path.basename(f)).join('、')}`);
    // 大文件要直传阿里云 OSS，给足时间
    await page.waitForTimeout(6000);
  }

  log('  等待所有上传完成…');
  await page.waitForTimeout(3000);
}

/**
 * 第 4c 步：从常用材料库引入固定材料。
 *
 * 平台**不会**校验这两项 —— 少传照样能点「下一步」，不会有任何提示，
 * 所以必须脚本主动补，别指望报错兜底。
 *
 * - 当事人身份证明：上传的只有被告的，原告（示例保险）的要从常用材料引入
 * - 委托代理人委托手续和身份材料：上传的只有授权委托书和公函，律师执业证要引入；
 *   传谁的执业证看授权委托书/公函里委托了谁（只有张律师就一张，张律师+李律师就两张）
 */
async function step4cImportCommon(page, lawyers, opts = {}) {
  log('第4c步 引入常用材料');

  // 常用材料库里执业证按「委托了几个人」分成两个分组，名字不成规律，
  // 是人工建的，只能写死映射（2026-01-01 实际库内容）：
  //   一人 → 「律师执业证_张律师」
  //   两人 → 「张律师和李律师的执业证」  ← 注意不是「律师执业证_张律师_李律师」
  // 别的代理人组合（如张律师+王律师）库里没有合并分组，是两条独立记录，
  // 这时候用 --certs 指名，一个槽位连引两条。
  const certItems =
    opts.certs && opts.certs.length
      ? opts.certs
      : [lawyers.length > 1 ? '张律师和李律师的执业证' : '律师执业证_张律师'];

  // 原告身份证明默认是示例保险那条；换原告（某保险分公司等）用 --plaintiff-cert 指名。
  // 案件目录里已经自带原告身份材料（营业执照+法定负责人身份证明）时，
  // 传 --plaintiff-cert none 跳过，别再从常用材料引一份负责人对不上的进来（张宗军案）。
  const plaintiffCert = opts.plaintiffCert || '身份证明_示例保险_负责人';
  const skipPlaintiffCert = ['none', 'no', 'skip', '无', '不引'].includes(String(plaintiffCert).toLowerCase());

  const jobs = [
    ...(skipPlaintiffCert ? [] : [{ slot: '当事人身份证明', items: [plaintiffCert], soft: true }]),
    { slot: '委托代理人委托手续和身份材料', items: certItems },
  ];
  if (skipPlaintiffCert) log('  原告身份证明：目录里已自带，跳过常用材料引入');

  for (const { slot, items, soft } of jobs) {
    log(`  ${slot} ← ${items.join('、')}`);

    // 一个槽位要引多条时，**每条都得重新打开一次弹窗**：引入一条之后弹窗自动关掉，
    // 接着去找第二条的「引入材料」按钮必然找不到（张律师+王律师两条执业证栽在这）。
    for (const name of items) {
      try {
        // 上一轮引入（或上一轮失败后没关干净）可能把弹窗留在页面上，
        // 残留遮罩会让下面的「引入常用材料」点不动。开之前先确认是干净的。
        await closeImportDialog(page);
        await openImportDialog(page, slot);
        const hit = await clickRowButton(page, name, '引入材料');
        await page.waitForTimeout(2500);
        if (hit && hit !== name) log(`    「${name}」→ 实际引入「${hit}」`);
      } catch (e) {
        // 原告身份证明引不到不该把整轮跑挂 —— 换原告（其他保险公司广西等）时库里未必有对应条目，
        // 报错里已经列出库里全部条目，看一眼就知道该传什么关键词，材料本身人工补也很快。
        // 律师执业证仍然硬失败：那是每案必有的，引不到多半是参数写错了。
        if (!soft) throw e;
        warn(`  ⚠ 原告身份证明没引进来：${e.message}`);
        warn('  ⚠ 这一份要人工补，或者用 --plaintiff-cert 指名后重跑');
        await closeImportDialog(page);
      }
    }
  }
}

/** 弹窗是否真的还在页面上（只看**可见**的那层，不看隐藏的模板副本） */
async function anyImportDialogVisible(page) {
  return page
    .evaluate(() => {
      return Array.from(document.querySelectorAll('.fd-import-file-layer')).some((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    })
    .catch(() => false);
}

/**
 * 关掉「引入常用材料」弹窗。
 * 引材料失败后必须真的关掉它 —— 光按 Escape 关不掉，弹层（.fd-import-file-layer）
 * 会一直盖着，下一个槽位的「引入常用材料」点上去只会超时（段晋林案栽在这）。
 *
 * ⚠ 2026-01-04 示例案件B：这个函数曾经「假成功」。原来的写法有两处错：
 *   1) 判定用 `page.locator('.fd-import-file-layer').first().isVisible()`——
 *      uni-app 会把弹层渲染成多份（含隐藏模板），first() 命中的是隐藏那份，
 *      于是弹窗明明还开着却判定成已关，连告警都不发；
 *   2) 兜底点的是 (60, 300)，那是**弹窗卡片内部**（卡片大约 x≥55、y≥90），点了等于没点。
 *   后果：「原告身份证明引不到 → 关弹窗 → 引律师执业证」这条链上，
 *   关弹窗假成功，下一个槽位的 openImportDialog 被残留遮罩挡住，
 *   报错是 `locator('text=引入常用材料') … .fd-import-file-layer … intercepts pointer events`，
 *   整轮挂在第 4c 步。凡是用 --plaintiff-cert 传了库里没有的条目都会踩到。
 *   现在：判定只看可见层；关闭优先点弹窗右上角的 ✕，兜底点视口角落的遮罩。
 */
async function closeImportDialog(page) {
  if (!(await anyImportDialogVisible(page))) return true;

  for (const t of ['取消', '关闭']) {
    if (await clickTextIfVisible(page, t)) {
      await page.waitForTimeout(800);
      break;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(600);

  // 还开着就点弹窗右上角的 ✕（卡片首行、靠右、无文字或单字的最右一个元素）
  for (let attempt = 0; attempt < 2 && (await anyImportDialogVisible(page)); attempt++) {
    const box = await page
      .evaluate(() => {
        const visible = (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const layers = Array.from(document.querySelectorAll('.fd-import-file-layer')).filter(visible);
        if (!layers.length) return null;
        const layer = layers[layers.length - 1]; // 后插进 DOM 的才是当前这一层
        const card = layer.querySelector('.fd-com-card') || layer;
        const cr = card.getBoundingClientRect();
        const cands = Array.from(card.querySelectorAll('*')).filter((e) => {
          if (!visible(e) || e.children.length > 1) return false;
          const r = e.getBoundingClientRect();
          if (r.top > cr.top + 70) return false; // 只看卡片首行
          if (r.left < cr.right - 90) return false; // 只看向右边缘
          return e.textContent.trim().length <= 2;
        });
        if (!cands.length) return null;
        const r = cands[cands.length - 1].getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .catch(() => null);

    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      // 兜底：点视口左下角的遮罩 —— 离居中的卡片最远，确定在卡片之外
      const [, vh] = await page.evaluate(() => [window.innerWidth, window.innerHeight]).catch(() => [1280, 800]);
      await page.mouse.click(6, Math.max(20, vh - 6));
    }
    await page.waitForTimeout(900);
  }

  if (await anyImportDialogVisible(page)) {
    warn('  引入弹窗关不掉，后面的引入可能被它挡住');
    return false;
  }
  return true;
}

/** 点某个材料槽位标题同一行右侧的「引入常用材料」，把弹窗打开 */
async function openImportDialog(page, slot) {
  {
    // 「引入常用材料」按钮在槽位标题同一行的右侧，取 y 最接近标题的那个
    const idx = await page.evaluate((slotName) => {
      const names = slotName === '其他' ? ['其他', '其他材料', '其他诉讼材料'] : [slotName];
      const title = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length === 0 && names.includes(e.textContent.trim())
      );
      if (!title) return -1;
      const ty = title.getBoundingClientRect().top;
      const btns = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && /引入常用材料/.test(e.textContent.trim())
      );
      let best = -1;
      let bestGap = Infinity;
      btns.forEach((el, i) => {
        const gap = Math.abs(el.getBoundingClientRect().top - ty);
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      });
      return bestGap < 60 ? best : -1;
    }, slot);

    if (idx < 0) throw new Error(`找不到「${slot}」的「引入常用材料」按钮`);

    await page
      .locator('text=引入常用材料')
      .nth(idx)
      .click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  }
}

/**
 * 第 4b 步：生成送达地址确认书。
 * 不是上传文件，而是用账号里已存的邮寄地址 + 电子签名由平台生成。
 * 流程：引入送达地址确认书 → 选择地址 → 选默认地址 → 确认生成 → 选第一个签名 → 引入签章
 */
async function step4bDeliveryAddress(page) {
  log('第4b步 生成送达地址确认书');

  await clickTextLoose(page, '引入送达地址确认书');
  await page.waitForTimeout(2000);

  log('  展开「选择地址」');
  await clickText(page, '请选择');
  await page.waitForTimeout(1200);

  log('  选默认地址');
  await clickWhere(
    page,
    () => {
      // 地址项的形态是「……（姓名 手机号）」
      const els = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && /\d{11}\s*[）)]\s*$/.test(e.textContent.trim())
      );
      const el = els.find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    '默认送达地址'
  );
  await page.waitForTimeout(1200);

  log('  确认生成');
  await clickText(page, '确认生成');
  await page.waitForTimeout(3000);

  log('  选第一个签名');
  await clickWhere(
    page,
    () => {
      // 签名是图片缩略图，取第一个可见且尺寸像缩略图的
      const imgs = Array.from(document.querySelectorAll('img, uni-image')).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 50 && r.height > 20 && r.top > 0;
      });
      if (!imgs.length) return null;
      const r = imgs[0].getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    '电子签名缩略图'
  );
  await page.waitForTimeout(1000);

  log('  引入签章');
  await clickTextLoose(page, '引入签章');
  await page.waitForTimeout(3500);
}

/**
 * 点「保存」并确认真的存进去了。
 *
 * 平台的校验失败是**静默**的：表单原地留着、字段下方冒一行红字，
 * 不弹窗也不报错。只打日志不校验的话，脚本会带着一个没关掉的表单继续往下跑，
 * 后面所有「在当前表单里找字段」的操作全部错位。
 */
/**
 * 把「完善案件信息」整页拍下来——`fullPage: true` 在这个站点没用：
 * 内容装在一个内层滚动容器里，截出来永远只有当前那一屏，
 * 结果就是标的金额、原告、被告一这些在上半屏的字段根本没进图，没法逐字段核对。
 * 所以先滚到顶，再一屏一屏往下拍。
 */
async function shootWholeStep(page, dir, base) {
  await page.mouse.move(720, 500);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -900);
  await page.waitForTimeout(1200);

  const files = [];
  let last = '';
  for (let i = 1; i <= 8; i++) {
    const f = path.join(dir, `${base}_${i}.png`);
    await page.screenshot({ path: f });
    files.push(f);

    // 滚到底了就收工。注意不能拿页面文字当判据 —— 内容全在 DOM 里，
    // 滚动并不改变 innerText，一比就相等，第二屏就假性收工了。要看滚动条位置。
    const sig = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*'))
        .filter((e) => e.scrollHeight > e.clientHeight + 50)
        .map((e) => e.scrollTop)
        .join(',')
    );
    if (sig === last) break;
    last = sig;

    // 步长要明显小于「可视高度减去顶部固定的步骤条」。步骤条大约占 185px，
    // 900 高的视窗里真正能看见的只有 650 左右；按 700 滚会有一条带子每次都躲在
    // 步骤条底下，被告的姓名/性别那行就是这么漏掉的（倪金亮案）。
    await page.mouse.wheel(0, 520);
    await page.waitForTimeout(900);
  }
  return files;
}

async function saveAndVerify(page, label) {
  await closeTreePickers(page);
  log(`    保存${label}`);
  // 校验不通过时平台有时是字段下方冒红字、有时是弹个一两秒就消失的 toast。
  // 只等 3 秒再看页面，toast 早没了，报出来就成了「表单没关」这种没信息量的错
  // （段晋林案的原告信用代码少了一位，就是这么被藏起来的）。
  const toastWatch = watchToast(page, 6000);
  await clickTextLoose(page, '保存');
  await page.waitForTimeout(3000);
  const toasts = await toastWatch;

  const problem = await page.evaluate(() => {
    const vis = (e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    };
    const err = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length === 0 && vis(e) && /不能为空|请填写|格式不正确|不能超过/.test(e.textContent)
    );
    if (err) return { kind: 'invalid', msg: err.textContent.trim().slice(0, 60) };

    // 表单还开着（还有可见的「保存」按钮）说明没存进去
    const stillOpen = Array.from(document.querySelectorAll('*')).some(
      (e) => e.children.length === 0 && e.textContent.trim() === '保存' && vis(e)
    );
    return stillOpen ? { kind: 'open' } : null;
  });

  if (problem?.kind === 'invalid') {
    throw new Error(`${label} 保存被平台拒绝：${problem.msg}`);
  }
  if (problem?.kind === 'open') {
    throw new Error(
      `${label} 点了保存但表单没关` +
      (toasts.length ? `，平台提示：${toasts.join(' / ')}` : '，且没抓到任何提示，多半是某个必填项没填或格式不对')
    );
  }
}

/**
 * 添加一个被告。三种类型走三个不同的按钮，字段也不一样。
 *
 * - 自然人：必填 姓名、性别、住所地（户籍所在地）
 * - 法人（有限公司这类）/ 其他组织（分公司这类，平台叫「非法人组织」）：
 *   必填 名称、住所地，统一社会信用代码和法定代表人一并填上
 *
 * 分公司要用「添加其他组织」，不是「添加法人」——平台把分公司归为非法人组织。
 */
async function addDefendant(page, d, label, section = '被告信息') {
  const type = d.type || '自然人';
  const button = { 自然人: '添加自然人', 法人: '添加法人', 其他组织: '添加其他组织' }[type];
  if (!button) throw new Error(`当事人类型「${type}」不认识，只能是 自然人/法人/其他组织`);

  log(`  ${label}：${button} ${d.name}`);
  await clickSectionButton(page, section, button);
  await page.waitForTimeout(2500);

  // 可选字段：不同当事人类型的表单字段不一样（法人没有「主要负责人手机号码」，
  // 非法人组织才有），填不到就跳过，不要因为一个可选项把整轮跑挂。
  const fillOptional = async (label, value) => {
    if (!value) return;
    try {
      await fillLabeled(page, label, value);
    } catch (e) {
      warn(`    「${label}」这个表单里没有，跳过`);
    }
  };

  if (type === '自然人') {
    if (section === '被执行人') {
      await pickLabeled(page, '当事人类型', '自然人');
      await pickLabeled(page, '国别或地区', '中国');
      if (d.idNo) await pickLabeled(page, '证件类型', '居民身份证');
    }
    await fillLabeled(page, '姓名', d.name);
    await pickLabeled(page, '性别', d.gender);
    await fillLabeled(page, '住所地', d.address);
    await fillOptional('证件号码', d.idNo);
    // 自然人当事人的联系电话不是必填，但当事人给了就录上，法院送达用得着
    await fillOptional('联系电话', d.phone);
  } else {
    // 组织名称：**执行页（被执行人）这张表单的标签是「单位名称」，一审被告表单是「名称」**。
    // 原来只试「名称」，执行立案里加法人/非法人组织被执行人必挂在 no-label
    // （李虎案 2026-01-05：被执行人2 人保遵义分公司）。容错两个叫法都试一遍。
    let orgNamed = false;
    for (const lbl of ['单位名称', '名称']) {
      try { await fillLabeled(page, lbl, d.name); orgNamed = true; break; } catch (e) {}
    }
    if (!orgNamed) throw new Error(`组织名称没填上（「单位名称」「名称」都没找到）：${d.name}`);
    await fillLabeled(page, '住所地', d.address);
    // 「证照类型」在被告表单里可空，**原告表单里是必填**（某保险分公司案报「证照类型不能为空」）。
    // case.json 给 certType 就选，一般是「统一社会信用代码证」。
    if (d.certType) {
      try {
        await pickLabeled(page, '证照类型', d.certType);
      } catch (e) {
        warn(`    「证照类型」选不上（${e.message}），继续`);
      }
    }
    await fillOptional('统一社会信用代码', d.creditCode);
    // 负责人姓名：非法人组织的标签是「主要负责人姓名」，法人被告才叫「法定代表人」。
    // 两个叫法都试，填不到就算了（被执行人这一侧只有名称是必填）。
    if (d.legalRep) {
      for (const lbl of ['主要负责人姓名', '法定代表人']) {
        try { await fillLabeled(page, lbl, d.legalRep); break; } catch (e) {}
      }
    }
    // 国别这两个是带下拉的，选不上就跳过
    for (const [lbl, opt] of [
      ['注册登记地国别或地区', '中国'],
      ['主要负责人国别或地区', '中国'],
    ]) {
      try { await pickLabeled(page, lbl, opt); await dismissTreeCover(page); } catch (e) { await dismissTreeCover(page); }
    }
    // 手机号字段两种表单叫法不一样：非法人组织是「主要负责人手机号码」（必填），
    // 法人是「法定代表人手机号码」（选填）。原来只试前者，法人被告的手机号就白拿了：
    // 日志只留一句「这个表单里没有，跳过」，字段空着就交上去。两个叫法都试一遍。
    if (d.phone) {
      const phoneLabels = type === '法人'
        ? ['法定代表人手机号码', '主要负责人手机号码']
        : ['主要负责人手机号码', '法定代表人手机号码'];
      let done = false;
      for (const lb of phoneLabels) {
        try {
          await fillLabeled(page, lb, d.phone);
          done = true;
          break;
        } catch (e) { /* 换下一个叫法 */ }
      }
      if (!done) warn(`    手机号填不进去（${phoneLabels.join(' / ')} 都没找到）`);
    }
  }

  await saveAndVerify(page, label);
}

/**
 * 第 5 步：完善案件信息。
 *
 * ⚠ 未实跑验证 —— 按用户口述的操作顺序写的，下个案子首跑时重点盯这里。
 *
 * - 标的金额：必填
 * - 原告：点「引入当事人」，库里有「示例保险」，直接引用
 * - 被告：点「添加自然人」，标红的是必填 —— 姓名、性别、住所地；身份证号一并填上
 * - 代理人：平台会自动带出张律师但标「待补全」，要点「编辑」补被代理人和代理人类型，
 *   并把联系电话改成 13800000000（自动带出来的是另一个号，必须改）
 */
async function step5CaseInfo(page, c) {
  log('第5步 完善案件信息');

  // 续跑时这一页可能已经填过一部分，每一项都要先判断有没有，
  // 否则会重复添加（两个原告、两个被告）。
  const amountBox = inputByPlaceholder(page, '请输入');
  const cur = await amountBox.inputValue().catch(() => '');
  if (cur && cur.trim()) {
    log(`  标的金额已有：${cur}，跳过`);
  } else {
    log(`  标的金额：${c.amount}`);
    await amountBox.fill(String(c.amount));
    await page.waitForTimeout(600);
  }

  // 「引入当事人」开的是「常用联系人」列表弹窗，里面不止一条（示例保险、某保险苏州…），
  // 每条自带一个「引入」按钮，没有统一的「确定」——必须点目标那一条自己的按钮。
  const plaintiff = c.plaintiff || '示例保险股份有限公司某分公司';
  if (await page.locator(`text=${plaintiff}`).first().isVisible().catch(() => false)) {
    log('  原告已存在，跳过');
  } else if (c.plaintiffInfo) {
    // 「常用联系人」库里只有示例保险和某保险苏州两条，别的原告（某保险分公司等）引不进来，
    // 只能照被告的填法手工录。case.json 里给 plaintiffInfo 就走这条路。
    await addDefendant(page, c.plaintiffInfo, '原告', '原告信息');
  } else {
    log(`  原告：引入当事人 → ${plaintiff}`);
    await clickSectionButton(page, '原告信息', '引入当事人');
    await page.waitForTimeout(2500);
    await clickRowButton(page, plaintiff, '引入');
    await page.waitForTimeout(3000);
    // 引入之后原告那块是展开的编辑态，必须点「保存」收起来，否则后面全乱
    await saveAndVerify(page, '原告');
  }

  // 被告可能不止一个，且类型不同（自然人 / 法人 / 其他组织）。
  // case.json 用 defendants 数组；单被告时也兼容旧的 defendant 对象。
  const defendants = c.defendants || (c.defendant ? [c.defendant] : []);
  if (!defendants.length) throw new Error('case.json 里没有被告信息');

  for (let i = 0; i < defendants.length; i++) {
    const d = defendants[i];
    const label = `被告${defendants.length > 1 ? i + 1 : ''}`;
    if (await page.locator(`text=${d.name}`).first().isVisible().catch(() => false)) {
      log(`  ${label} ${d.name} 已存在，跳过`);
      continue;
    }
    await addDefendant(page, d, label);
  }

  log('  代理人：补全被代理人 / 代理人类型 / 联系电话');
  // 原告卡片也有「编辑」，不能按文字点第一个，必须锁定代理人那一行
  await clickSectionButton(page, '代理人1', '编辑');
  await page.waitForTimeout(2500);
  // 被代理人是复选框（勾上原告），不是下拉
  await checkLabeled(page, '被代理人');
  await pickLabeled(page, '代理人类型', '执业律师');
  // 平台自动带出来的电话是旧号，必须改
  await fillLabeled(page, '联系电话', c.agentPhone || '13800000000');
  await saveAndVerify(page, '代理人');
}

/**
 * 点某个区块标题同一行的按钮（「原告信息」「被告信息」都有同名的
 * 「引入当事人 / 添加自然人」，按下标取会因为表单展开而错位）。
 */
async function clickSectionButton(page, sectionTitle, buttonText) {
  // 不用「第 N 个」——页面里算出的序号和 Playwright 的匹配集合对不上，
  // 改成在页面里给目标元素打标记，再用标记选中它。
  const r = await page.evaluate(
    ([sec, btn]) => {
      document.querySelectorAll('[data-click-target]').forEach((e) => e.removeAttribute('data-click-target'));

      const visible = (e) => {
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };
      // 标题可能是「代理人1」+ 子元素「（待补全）」，不能要求无子元素；
      // 取文本最短的那个匹配元素（即最贴近标题本身的那层）。
      const cands = Array.from(document.querySelectorAll('*')).filter((e) => {
        const txt = e.textContent.trim();
        return txt.startsWith(sec) && txt.length < 30 && visible(e);
      });
      if (!cands.length) return 'no-section';
      const t = cands.reduce((a, b) => (a.textContent.trim().length <= b.textContent.trim().length ? a : b));

      const ty = t.getBoundingClientRect().top;
      const btns = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && visible(e) &&
               e.textContent.trim().replace(/^[+＋]\s*/, '') === btn
      );
      if (!btns.length) return 'no-button';

      let best = null;
      let bestGap = Infinity;
      btns.forEach((el) => {
        const gap = Math.abs(el.getBoundingClientRect().top - ty);
        if (gap < bestGap) { bestGap = gap; best = el; }
      });
      if (bestGap > 80) return 'too-far:' + Math.round(bestGap);

      best.setAttribute('data-click-target', '1');
      return 'ok';
    },
    [sectionTitle, buttonText]
  );
  if (r !== 'ok') throw new Error(`找不到「${sectionTitle}」这一行的「${buttonText}」按钮（${r}）`);
  await page.locator('[data-click-target="1"]').click({ timeout: 8000 });
}

/**
 * 列表型弹窗里，点某一条自己的按钮（每条都有一个同名按钮，不能只按文字点）。
 * 做法：先定位这一条的标题，再取标题下方最近的那个按钮。
 */
async function clickRowButton(page, rowTitle, buttonText) {
  const idx = await page.evaluate(
    ([title, btn]) => {
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const leaves = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && vis(e));
      // 先精确，再按关键词包含 —— 常用材料库里的条目名是人工建的、记不住确切写法，
      // 允许传「某保险」「王律师」这种关键词。命中多条就不猜，交给下面报错列清单。
      let t = leaves.find((e) => e.textContent.trim() === title);
      if (!t) {
        const hits = leaves.filter((e) => {
          const x = e.textContent.trim();
          return x.length <= 40 && x.includes(title) && x !== btn;
        });
        if (hits.length === 1) t = hits[0];
      }
      if (!t) return -1;
      window.__rowTitleHit = t.textContent.trim();
      const ty = t.getBoundingClientRect().top;
      const btns = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && e.textContent.trim() === btn
      );
      let best = -1;
      let bestGap = Infinity;
      btns.forEach((el, i) => {
        const gap = el.getBoundingClientRect().top - ty;
        if (gap > 0 && gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      });
      return best;
    },
    [rowTitle, buttonText]
  );
  if (idx < 0) {
    // 报错时把弹窗里所有条目列出来 —— 库里的名字是人工建的，猜不中就靠这一行看清
    const items = await page.evaluate(() => {
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return [...new Set(Array.from(document.querySelectorAll('*'))
        .filter((e) => e.children.length === 0 && vis(e))
        .map((e) => e.textContent.trim())
        .filter((t) => t && t.length >= 4 && t.length <= 40))];
    }).catch(() => []);
    throw new Error(
      `弹窗里找不到「${rowTitle}」这一条的「${buttonText}」按钮。` +
      `弹窗里可见的条目：${items.join(' | ')}`
    );
  }
  await page.locator(`text="${buttonText}"`).nth(idx).click({ timeout: 8000 });
  // 把**实际命中**的条目名返回去 —— 传关键词时，光看日志里的关键词说明不了引对没引对
  return page.evaluate(() => window.__rowTitleHit || '').catch(() => '');
}

/**
 * 在**当前展开的那个表单内**按标签定位输入框，并打上标记供 Playwright 操作。
 *
 * 必须限定在表单内：页面上方已保存的卡片（原告、代理人）里也有「证件号码」
 * 「住所地」「姓名」这些字，用全页第一个/最后一个匹配都会填错地方
 * —— 实测把身份证号填进了姓名栏、住所地留空。
 *
 * 控件必须属于标签所在的 uni-forms-item；已保存卡片没有编辑控件，不参与匹配。
 */
// 按 uni-forms-item 的标签绑定控件，不能按三列表单的屏幕位置猜。
async function markFormItem(page, label, selector) {
  return page.evaluate(([lab, sel]) => {
    document.querySelectorAll('[data-form-field]').forEach(e => e.removeAttribute('data-form-field'));
    const norm = text => text.trim().replace(/^\*/, '').replace(/\s/g, '');
    const items = [...document.querySelectorAll('.uni-forms-item')].filter(e => {
      const rect = e.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && e.querySelector(sel);
    });
    const name = e => norm(e.querySelector('.uni-forms-item__label')?.innerText || '');
    let matches = items.filter(e => name(e) === norm(lab));
    if (!matches.length) matches = items.filter(e => name(e).startsWith(norm(lab)));
    if (matches.length !== 1) return matches.length ? 'ambiguous-label' : 'no-label';
    matches[0].setAttribute('data-form-field', '1');
    return 'ok';
  }, [label, selector]);
}

async function markFieldInOpenForm(page, label) {
  const result = await markFormItem(page, label, 'input,textarea,.uni-data-tree-input');
  if (result !== 'ok') return result;
  return page.evaluate(() => {
    document.querySelectorAll('[data-fill-target]').forEach(e => e.removeAttribute('data-fill-target'));
    const item = document.querySelector('[data-form-field="1"]');
    const control = item.querySelector('.uni-data-tree-input') || item.querySelector('input,textarea');
    if (!control) return 'no-control';
    control.setAttribute('data-fill-target', '1');
    return 'ok';
  });
}

async function closeTreePickers(page) {
  // 触发组件自身的关闭事件，不能只让透明 cover 不拦点击：弹层仍会盖住保存按钮。
  for (const cover of await page.locator('.uni-data-tree-cover').all()) {
    await cover.dispatchEvent('click');
  }
  await dismissTreeCover(page);
}

async function fillLabeled(page, label, value) {
  const r = await markFieldInOpenForm(page, label);
  if (r !== 'ok') throw new Error(`表单里定位不到「${label}」输入框（${r}）`);
  await page.locator('[data-fill-target="1"]').fill(String(value), { timeout: 8000 });
  await page.waitForTimeout(400);
}

async function pickLabeled(page, label, option) {
  await closeTreePickers(page);
  const result = await markFieldInOpenForm(page, label);
  if (result !== 'ok') throw new Error(`表单里定位不到「${label}」选择框（${result}）`);
  const control = page.locator('[data-fill-target="1"]');
  const shown = () => control.locator('.selected-area').first().innerText();
  if ((await shown()).trim() === option) return;
  try {
    await control.click({ timeout: 8000 });
    await page.waitForTimeout(700);
    const found = await page.evaluate(opt => {
      document.querySelectorAll('[data-option-target]').forEach(e => e.removeAttribute('data-option-target'));
      const tree = document.querySelector('[data-fill-target="1"]')?.closest('.uni-data-tree');
      if (!tree) return 'no-tree';
      const options = [...tree.querySelectorAll('*')].filter(e => {
        const r = e.getBoundingClientRect();
        return e.children.length === 0 && e.textContent.trim() === opt && r.width > 0 && r.height > 0 && !e.classList.contains('selected-area');
      });
      if (options.length !== 1) return `option-count:${options.length}`;
      options[0].setAttribute('data-option-target', '1');
      return 'ok';
    }, option);
    if (found !== 'ok') throw new Error(`「${label}」下拉找不到唯一选项「${option}」（${found}）`);
    await page.locator('[data-option-target="1"]').click({ timeout: 8000 });
    await page.waitForTimeout(400);
    if ((await shown()).trim() !== option) throw new Error(`「${label}」选择后的值与「${option}」不一致`);
  } finally {
    await closeTreePickers(page);
  }
}

/**
 * 勾选复选框型字段。代理人表单里的「被代理人」就是复选框
 * （□ 示例保险股份有限公司某分公司），不是下拉。
 */
async function checkLabeled(page, label, option) {
  const result = await markFormItem(page, label, '.uni-data-checklist');
  if (result !== 'ok') throw new Error(`表单里定位不到「${label}」复选框（${result}）`);
  let boxes = page.locator('[data-form-field="1"] .checklist-box');
  if (option) boxes = boxes.filter({ hasText: option });
  if (await boxes.count() !== 1) throw new Error(`「${label}」复选框不唯一，请指定被代理人`);
  if ((await boxes.getAttribute('class') || '').includes('is-checked')) return;
  await boxes.click({ timeout: 8000 });
  if (!(await boxes.getAttribute('class') || '').includes('is-checked')) throw new Error(`「${label}」未能勾选`);
}

/** 材料页上还空着的必传槽位（送达地址确认书这类要「引入」而非上传的也算） */
async function pendingRequiredSlots(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.fd-btn-add').forEach((add) => {
      // 往上找到该槽位区块，判断里面有没有已上传的文件卡片
      let box = add;
      for (let i = 0; i < 5 && box.parentElement; i++) box = box.parentElement;
      const text = (box.textContent || '').trim();
      const m = text.match(/^([一-龥（）()、]+?)\s*（必传材料）/);
      if (!m) return;
      const hasFile = !!box.querySelector('.fd-file-container:not(.fd-btn-add)');
      if (!hasFile) out.push(m[1]);
    });
    return [...new Set(out)];
  });
}

/**
 * 点下一步，并等下一页的特征元素真的出现才算成功。
 * 不要用「步骤标题还是不是高亮色」判断——颜色值随版本变，判断不可靠。
 */
async function goNext(page, expectMarker, { timeout = 20000 } = {}) {
  await clickText(page, '下一步');

  try {
    await page.locator(`text=${expectMarker}`).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch (e) {
    const pending = await pendingRequiredSlots(page).catch(() => []);
    if (pending.length) {
      throw new Error(
        `「下一步」点不动：还有必传材料没备齐 —— ${pending.join('、')}。` +
        `\n  送达地址确认书/收款账户确认书不是上传文件，要点右上角「引入」按钮由平台生成。`
      );
    }
    throw new Error(`点了「下一步」但没等到「${expectMarker}」，页面可能没跳转`);
  }
}

/* ==================== 申请执行（强制执行）分支 ====================
 *
 * 和民事一审的差别：
 *   - 入口卡片是「申请执行」，不是「民事一审」
 *   - 没有「立案案由」这一步，也没有「立案方式（已准备诉状）」这一步
 *   - 多出「执行依据」：选类别 → 选/填原审案号 → 保存（会弹确认框），
 *     保存之后平台才回填「作出执行依据单位 / 执行依据文书文号」并展开材料槽位
 *   - 材料槽位只有一个必传（授权委托书及代理人身份证明）
 */

// 保存执行依据之后才展开的槽位：
//   执行申请书                  非必传（平台说会按填写信息自动生成，但当事人签章的正本还是要传）
//   执行依据文书                非必传（判决书 / 裁定书 / 调解书）
//   授权委托书及代理人身份证明  **唯一必传**
//   申请人身份材料              非必传，走「引入常用材料」
//   送达地址确认书              非必传，走「引入送达地址确认书」
const SLOTS_ZHIXING = [
  // 姑苏区法院要随申请书一起交「申请执行人初次接待谈话笔录」，执行材料页没有
  // 「其他材料」槽位，就并进这一格（李明案 2026-09-17 与用户确认）。
  { slot: '执行申请书',                 match: /执行申请书|谈话笔录|约谈笔录/, all: true, optional: true },
  { slot: '执行依据文书',               match: /判决书|裁定书|调解书|仲裁裁决/,       optional: true },
  { slot: '授权委托书及代理人身份证明', match: /委托手续|授权委托书|公函/, all: true },
  // 申请人身份材料一般走「引入常用材料」（示例保险那条）。但原告换成别的分支
  // （示例保险某支公司等）时库里没有，目录里会自带营业执照+负责人身份证明，直接传。
  { slot: '申请人身份材料', match: /身份证明/, all: true, optional: true },
];

/** 第 2 步（执行版）：只有须知，没有立案方式 */
async function step2NoticeZhixing(page) {
  log('第2步 阅读申请执行立案须知（已获授权自动勾选）');

  for (let i = 0; i < 3; i++) {
    if (!(await dismissPopups(page))) break;
    await page.waitForTimeout(600);
  }
  await clickText(page, '已阅读同意立案须知内容');
  await page.waitForTimeout(600);

  await clickText(page, '下一步');
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) {
    if (!(await dismissPopups(page))) break;
  }

  // 执行没有「请选择立案方式」这张卡片，须知之后直接是材料页（页头是「执行依据」）。
  // 个别版本要再点一次「下一步」才过去。
  const onMaterials = () =>
    page.locator('text=执行依据').first().isVisible().catch(() => false);
  if (!(await onMaterials())) {
    await clickTextIfVisible(page, '下一步');
    await page.waitForTimeout(3000);
  }
  if (!(await onMaterials())) throw new Error('须知之后没进到材料页（找不到「执行依据」）');

  if (page.__layyid) log(`  草稿已建 layyid=${page.__layyid}${page.__fyid ? ` fyid=${page.__fyid}` : ''}`);
}

/**
 * 第 3 步（执行版）：填执行依据。
 * 材料槽位是动态的 —— 不保存执行依据，下面的上传框根本不出现。
 */
async function step3Zhixing(page, casenum, court) {
  if (!casenum) {
    throw new Error('执行立案必须给原审案号：--casenum "（2026）苏0501民初1000号"，或写进 case.json 的 casenum');
  }
  log(`第3步 执行依据：${casenum}`);

  log('  执行依据类别 → 民商');
  await clickText(page, '请选择');
  await page.waitForTimeout(1000);
  await clickText(page, '民商');
  await page.waitForTimeout(2000);

  // 案号形如「（2026）苏0501民初1000号」，平台把它拆成 年份下拉 +「主体」文本框 +「号」，
  // 整串塞进一个框是错的；下拉里的搜索也只认主体（带括号搜不到）。
  const m = casenum.match(/[（(](\d{4})[）)]\s*(.+?)\s*号?$/);
  const body = m ? m[2] : casenum;
  log(`  原审案号 → 搜「${body}」`);

  await clickText(page, '请选择'); // 此时可见的是「原审案号」那个
  await page.waitForTimeout(1500);

  const search = page
    .locator('xpath=//*[normalize-space(text())="搜索关键词"]/following::input[1] | //input[@placeholder="搜索关键词"]')
    .first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(body).catch(() => {});
    await page.waitForTimeout(2000);
  }

  let hit = false;
  try {
    hit = await clickTextLoose(page, body, { timeout: 4000 });
  } catch (e) {}
  if (hit) {
    log('  命中平台已有案号（本院系统里查得到，最稳）');
  } else {
    // 「选择此项手动输入案号」只在**没有搜索词**的列表里才出现：
    // 搜出「无匹配数据」那一屏是空的，什么都点不到（郁登敏案栽在这）。
    // 所以先把搜索框清空，让完整列表回来。
    log('  没搜到，清空搜索词找「选择此项手动输入案号」');
    if (await search.isVisible().catch(() => false)) {
      await search.fill('').catch(() => {});
      await page.waitForTimeout(2000);
    }
    let manual = false;
    for (const t of ['选择此项手动输入案号', '手动输入案号', '手动输入']) {
      try { manual = await clickTextLoose(page, t, { timeout: 4000 }); } catch (e) {}
      if (manual) { log(`  点开了「${t}」`); break; }
    }
    if (!manual) {
      const texts = await page.evaluate(() => {
        const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        return [...new Set(Array.from(document.querySelectorAll('*'))
          .filter((e) => e.children.length === 0 && vis(e))
          .map((e) => e.textContent.trim())
          .filter((t) => t && t.length <= 24))];
      }).catch(() => []);
      throw new Error(`找不到手动输入案号的入口。当前页面可见文字：${texts.join('|')}`);
    }
    // 手动输入展开后是三行：*输入案号（年份下拉 + 文本框 + 「号」）、*作出执行依据单位（下拉）。
    // 这些控件是点开之后才渲染的，探早了全是 no-input —— 必须等标签真的出现。
    await page.locator('text=输入案号').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(2500);

    const year = m ? m[1] : '';
    if (year) {
      try {
        // 年份选项是全角括号包着的：（2025）
        await pickByLabelRow(page, '输入案号', [`（${year}）`, `(${year})`, year]);
        log(`  年份 → ${year}`);
      } catch (e) {
        warn(`  年份没选上（${e.message}），请人工确认是 ${year}`);
      }
    }

    const marked = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      document.querySelectorAll('[data-casenum]').forEach((e) => e.removeAttribute('data-casenum'));
      // ⚠ 别用 /输入案号/ 模糊匹配：上一行「原审案号」框里此刻显示的正是
      //   「选择此项手动输入案号」，它排在前面，一模糊就找错行（郁登敏案连挂两轮）。
      const label = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length === 0 && vis(e) &&
               e.textContent.trim().replace(/^\*/, '').replace(/\s/g, '') === '输入案号'
      );
      if (!label) return 'no-label';
      const lr = label.getBoundingClientRect();
      const input = Array.from(document.querySelectorAll('input, textarea')).filter(vis).find((i) => {
        const r = i.getBoundingClientRect();
        return Math.abs(r.top - lr.top) < 40 && r.left > lr.right;
      });
      if (!input) return 'no-input';
      input.setAttribute('data-casenum', '1');
      return 'ok';
    });
    if (marked !== 'ok') throw new Error(`定位不到「输入案号」文本框（${marked}）`);
    await page.locator('[data-casenum="1"]').fill(body);
    await page.waitForTimeout(800);
    log(`  案号主体 → ${body}`);

    // 走手动输入时平台没法按案号反查，「作出执行依据单位」要自己选（是下拉，不是文本框）
    if (court) {
      try {
        await pickByLabelRow(page, '作出执行依据单位', court, { search: court });
        log(`  作出执行依据单位 → ${court}`);
      } catch (e) {
        warn(`  作出执行依据单位没选上（${e.message}），请人工选「${court}」`);
      }
    }
  }
  await page.waitForTimeout(1200);

  log('  保存执行依据');
  // 刚选完「作出执行依据单位」那个树形下拉，它会留一层透明 cover 盖住整页，
  // 保存按钮点了毫无反应、也不报错（郁登敏案走手动输入时栽在这）。
  await dismissTreeCover(page);
  await clickWhere(
    page,
    () => {
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const el = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length === 0 && vis(e) && e.textContent.trim() === '保存'
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    '「保存」按钮'
  );

  // 一边等确认框，一边盯着一次性提示（平台拒绝时只弹一两秒的 toast）
  const toastWatch = watchToast(page, 14000);
  let confirmed = false;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    if (!confirmed && (await clickTextIfVisible(page, '确定'))) { confirmed = true; log('  已确认保存'); }
  }
  const toasts = await toastWatch;
  if (toasts.length) log(`  平台提示：${toasts.join(' / ')}`);

  // 仅表示平台当前未识别到生效状态，不能据此认定文书法律上未生效。
  // 用户 2026-10-14 要求：直接办理；平台拒绝时关闭本次浏览器并退出。
  const notEffective = toasts.find((t) => /未生效|尚未生效|没有生效/.test(t));
  if (notEffective) {
    const error = new Error(
      `平台拒绝：${notEffective}\n` +
      `  平台当前未识别到执行依据（${casenum}）的生效状态。\n` +
      `  请联系法院核查并点击生效；本次停止办理，不自动重试。`
    );
    error.code = 'EXECUTION_BASIS_NOT_EFFECTIVE';
    throw error;
  }
  if (!confirmed) warn('  没等到「请您确认是否保存？」确认框，保存多半没生效');

  // 保存成功的判据：材料槽位展开（必传那个出现）。
  // 「作出执行依据单位」「执行依据文书文号」由平台按案号自动回填，不用管。
  try {
    await page
      .locator('text=授权委托书及代理人身份证明')
      .first()
      .waitFor({ state: 'visible', timeout: 40000 });
  } catch (e) {
    const texts = await page.evaluate(() => {
      const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return [...new Set(Array.from(document.querySelectorAll('*'))
        .filter((el) => el.children.length === 0 && vis(el))
        .map((el) => el.textContent.trim())
        .filter((t) => t && t.length <= 30))].slice(0, 60);
    }).catch(() => []);
    throw new Error(
      `保存执行依据后材料槽位没展开。` +
      (toasts.length ? `平台提示过：${toasts.join(' / ')}。` : '整个过程没抓到任何平台提示。') +
      `当前可见文字：${texts.join('|')}`
    );
  }
  await page.waitForTimeout(3000);
  const slots = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.fd-btn-add').forEach((add) => {
      let box = add;
      for (let i = 0; i < 5 && box.parentElement; i++) box = box.parentElement;
      const m = (box.textContent || '').trim().match(/^([一-龥（）()、]+?)\s*（(必传|非必传)材料/);
      if (m) out.push(`${m[1]}${m[2] === '必传' ? '*' : ''}`);
    });
    return [...new Set(out)];
  }).catch(() => []);
  log(`  执行依据已保存，材料槽位已展开：${slots.join(' / ')}`);
}

/**
 * 表单内的「是/否」单选（不是下拉，也不是复选框）。
 * 代理人表单里的「是否法律援助」「同意电子送达」都是这种，两个圆点并排在标签右边。
 * 必须限定在当前展开的表单里选 —— 页面上方保存好的卡片里也有「是」「否」这种字。
 */
async function pickRadioInOpenForm(page, label, option) {
  const result = await markFormItem(page, label, '.uni-data-checklist');
  if (result !== 'ok') throw new Error(`表单里找不到「${label}」单选框（${result}）`);
  const choices = page.locator('[data-form-field="1"] .checklist-box');
  let found = null;
  for (const choice of await choices.all()) {
    if ((await choice.innerText()).trim() === option) {
      if (found) throw new Error(`「${label}」的「${option}」选项不唯一`);
      found = choice;
    }
  }
  if (!found) throw new Error(`「${label}」找不到「${option}」选项`);
  if (!(await found.getAttribute('class') || '').includes('is-checked')) await found.click({ timeout: 8000 });
  if (!(await found.getAttribute('class') || '').includes('is-checked')) throw new Error(`「${label}」未选中「${option}」`);
}

/** 让树形选择器的残留透明遮罩不再拦截后续点击。 */
async function dismissTreeCover(page) {
  // ⚠ 别用 isVisible() 判断有没有遮罩：这层 cover 是透明的，Playwright 判定「不可见」
  //   直接跳过，可它照样 intercepts pointer events，下一个下拉点到超时（被执行人甲案连挂两轮）。
  //   也别 remove()，那会打乱组件自己的状态；置 pointer-events:none 最轻。
  // 只处理「此刻已存在」的遮罩不够：下拉选失败后才冒出来的新遮罩没人清，
  // 后面所有点击都被挡（唐兵兵案 2026-09-17：申请执行人一个下拉没选上，
  // 被执行人/代理人/金钱给付全部超时）。所以同时注入一条全局样式，之后生成的也点不住。
  const n = await page.evaluate(() => {
    if (!document.getElementById('zxfw-no-tree-cover')) {
      const st = document.createElement('style');
      st.id = 'zxfw-no-tree-cover';
      st.textContent = '.uni-data-tree-cover{pointer-events:none !important}';
      document.head.appendChild(st);
    }
    const els = Array.from(document.querySelectorAll('.uni-data-tree-cover'));
    els.forEach((e) => { e.style.pointerEvents = 'none'; });
    return els.length;
  });
  if (n) await page.waitForTimeout(200);
  return n > 0;
}

/**
 * 下拉选项的确切写法拿不准时用：按正则挑，并把所有候选项打出来备查。
 * 「代理类型」就是这种 —— 不知道平台写的是「特别授权」还是「特别授权代理」。
 */
async function pickLabeledLike(page, label, re, desc) {
  await dismissTreeCover(page);
  const r = await markFieldInOpenForm(page, label);
  if (r !== 'ok') throw new Error(`表单里定位不到「${label}」选择框（${r}）`);

  const shown = () =>
    page.evaluate(() => {
      const e = document.querySelector('[data-fill-target="1"]');
      return e ? (e.value || e.textContent || '').trim() : '';
    });

  for (let attempt = 1; attempt <= 2; attempt++) {
    await dismissTreeCover(page);
    await page.locator('[data-fill-target="1"]').click({ timeout: 8000 });
    await page.waitForTimeout(1500);

    const opts = await page.evaluate(() => {
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return Array.from(document.querySelectorAll('*'))
        .filter((e) => e.children.length === 0 && vis(e))
        .map((e) => e.textContent.trim())
        .filter((t) => t && t.length <= 16);
    });
    const cands = [...new Set(opts)].filter((t) => re.test(t));
    if (attempt === 1) {
      if (cands.length) {
        log(`    「${label}」候选项：${cands.join(' / ')}`);
      } else {
        // 一个都没匹配上 —— 把下拉里的短文本全列出来，一次就能看清平台到底写的什么
        const all = [...new Set(opts)].filter((t) => t.length <= 10);
        log(`    「${label}」按关键字没匹配上，下拉里的文字：${all.join('|')}`);
      }
    }

    // 倒着点：弹层是后插进 DOM 的
    for (let i = cands.length - 1; i >= 0; i--) {
      const loc = page.locator(`text="${cands[i]}"`);
      const n = await loc.count().catch(() => 0);
      for (let j = n - 1; j >= 0; j--) {
        if (!(await loc.nth(j).isVisible().catch(() => false))) continue;
        await loc.nth(j).click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(700);
        const v = await shown();
        if (v && v !== '请选择' && re.test(v)) {
          log(`    「${label}」已选：${v}`);
          return v;
        }
      }
    }
  }
  throw new Error(`「${label}」下拉里挑不到${desc}`);
}

/**
 * 在指定区块内按标签填值。
 * 「执行标的信息」这块和当事人卡片不一样：**没有「保存」按钮**（靠「下一步」提交），
 * 控件又是 textarea —— markFieldInOpenForm 那套（先找可见的「保存」再往上找表单）
 * 在这里会锁到上面还开着的当事人表单去，把值填错地方。
 */
async function fillInSection(page, sectionTitle, label, value) {
  const isRe = label instanceof RegExp;
  const r = await page.evaluate(
    ([sec, labRaw, labIsRe]) => {
      const lab = labIsRe ? new RegExp(labRaw) : labRaw;
      document.querySelectorAll('[data-sec-fill]').forEach((e) => e.removeAttribute('data-sec-fill'));
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };

      const title = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length === 0 && vis(e) && e.textContent.trim() === sec
      );
      if (!title) return 'no-section';
      // 不要「从标题往上找容器」—— 中间那层包着两个 textarea 就会提前收口，
      // 把下面的金额输入框关在外面（第二轮就是这么报的 no-label）。
      // 改成全页找标签，只要求它在区块标题下方即可。
      const top = title.getBoundingClientRect().top;

      // 标签形如「*执行理由」「*申请执行标的的金额(元)」，去掉星号和括号后缀再比
      const norm = (t) => t.trim().replace(/^\*/, '').replace(/[（(].*$/, '').replace(/\s/g, '');
      const leaves = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && vis(e) && e.getBoundingClientRect().top >= top - 4
      );
      const want = lab instanceof RegExp ? lab : null;
      const labelEl = want
        ? leaves.find((e) => want.test(norm(e.textContent)))
        : leaves.find((e) => norm(e.textContent) === lab) ||
          leaves.find((e) => norm(e.textContent).startsWith(lab));
      if (!labelEl) {
        // 报错时把区块底下的短文本列出来，下次一眼就知道标签到底写的什么
        const cands = [...new Set(leaves.map((e) => norm(e.textContent)).filter((t) => t && t.length <= 20))];
        return 'no-label:' + cands.slice(0, 25).join('|');
      }

      const lp = labelEl.getBoundingClientRect();
      const ctrls = Array.from(document.querySelectorAll('textarea, input'))
        .filter(vis)
        .filter((e) => e.getBoundingClientRect().top >= top - 4);
      let best = null;
      let bestD = Infinity;
      for (const c of ctrls) {
        const r = c.getBoundingClientRect();
        const sameRow = Math.abs(r.top - lp.top) < 40 && r.left > lp.right - 8;
        const below = r.top >= lp.top - 8;
        if (!sameRow && !below) continue;
        const d = Math.abs(r.top - lp.top) * 3 + Math.max(0, r.left - lp.right) / 20;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (!best) return 'no-control';
      best.setAttribute('data-sec-fill', '1');
      return best.value && best.value.trim() ? 'filled' : 'ok';
    },
    [sectionTitle, isRe ? label.source : label, isRe]
  );
  if (r === 'filled') return 'filled';   // 已经有值（平台自动生成的），别覆盖
  if (r !== 'ok') throw new Error(`「${sectionTitle}」里定位不到「${label}」（${r}）`);

  await page.locator('[data-sec-fill="1"]').fill(String(value), { timeout: 8000 });
  await page.waitForTimeout(400);
  return 'ok';
}

/**
 * 第 4c 步（执行版）：从常用材料引入两样东西。
 *
 * ⚠ 「授权委托书及代理人身份证明」这个槽位要的是**两份**：
 *   授权委托书（案件目录里的委托手续 PDF）+ 代理人身份证明（律师执业证）。
 *   只传委托手续不够 —— 执业证在常用材料库里，得引进来。
 *   被执行人甲案首跑就漏了这份，是用户看出来的。
 */
async function step4cImportZhixing(page, plaintiffCert, lawyers, certs) {
  // 执业证按授权委托书/公函里实际委托了谁来引，规则和一审完全一致
  const certItems =
    certs && certs.length
      ? certs
      : [lawyers && lawyers.length > 1 ? '张律师和李律师的执业证' : '律师执业证_张律师'];

  log(`第4c步 代理人身份证明（执业证）← ${certItems.join('、')}`);
  for (const name of certItems) {
    // 一个槽位引多条时每条都得重开一次弹窗，引完弹窗就自动关了
    await openImportDialog(page, '授权委托书及代理人身份证明');
    const hit = await clickRowButton(page, name, '引入材料');
    await page.waitForTimeout(2500);
    if (hit && hit !== name) log(`    「${name}」→ 实际引入「${hit}」`);
  }

  const cert = plaintiffCert || '身份证明_示例保险_负责人';
  if (['none', 'no', 'skip', '无', '不引'].includes(String(cert).toLowerCase())) {
    log('  申请人身份材料：按参数跳过');
    return;
  }
  log(`  申请人身份材料 ← ${cert}`);
  await openImportDialog(page, '申请人身份材料');
  const hit2 = await clickRowButton(page, cert, '引入材料');
  await page.waitForTimeout(2500);
  if (hit2 && hit2 !== cert) log(`    「${cert}」→ 实际引入「${hit2}」`);
}

/**
 * 盯住 uni-app 的一次性提示（toast / 校验红字）。
 * 这类提示一两秒就消失，出错后再截图或 dump 页面文字统统抓不到，
 * 只能在点按钮的同时高频轮询。返回看到过的所有提示文字。
 */
async function watchToast(page, ms = 12000) {
  const seen = new Set();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hits = await page.evaluate(() => {
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const out = [];
      document.querySelectorAll('[class*="toast"],[class*="Toast"],[class*="message"],[class*="tips"],[class*="error"]')
        .forEach((e) => { if (vis(e)) { const t = (e.textContent || '').trim(); if (t && t.length <= 60) out.push(t); } });
      return out;
    }).catch(() => []);
    hits.forEach((t) => seen.add(t));
    await page.waitForTimeout(300);
  }
  return [...seen];
}

/**
 * 点开「某个标签同一行」的下拉并选中一项。
 *
 * 和 pickLabeled 的区别：那个要求表单里有可见的「保存」按钮来圈定范围，
 * 执行依据这张表单点开手动输入之后既有「保存」也有别的控件，圈不准；
 * 这里直接按标签所在行找那个「请选择」框，更直接。
 * opts.search：下拉里带搜索框时先搜一下（法院列表很长，不搜找不到）。
 */
async function pickByLabelRow(page, label, option, opts = {}) {
  await dismissTreeCover(page);
  const r = await page.evaluate(
    ([lab]) => {
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      document.querySelectorAll('[data-row-pick]').forEach((e) => e.removeAttribute('data-row-pick'));
      const labelEl = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length === 0 && vis(e) && e.textContent.trim().replace(/^\*/, '').startsWith(lab)
      );
      if (!labelEl) return 'no-label';
      const lr = labelEl.getBoundingClientRect();
      // 同一行、标签右侧、写着「请选择」的那个框（选过之后写的是已选值，也一并认）
      const cands = Array.from(document.querySelectorAll('*')).filter((e) => {
        if (!vis(e) || e.children.length > 2) return false;
        const r = e.getBoundingClientRect();
        return Math.abs(r.top - lr.top) < 40 && r.left >= lr.right - 4 && r.width > 40 && r.height > 16;
      });
      // 优先取「自己的文字就是请选择」的那个（最贴近控件本身），
      // 退而求其次才要包含它的外层，否则会点到撑满整行的包装层上、毫无反应。
      const exact = cands.find((e) => e.textContent.trim() === '请选择');
      const pick = exact || cands.find((e) => /请选择/.test(e.textContent)) || cands[0];
      if (!pick) return 'no-control';
      pick.setAttribute('data-row-pick', '1');
      const b = pick.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    [label]
  );
  if (typeof r === 'string') throw new Error(`定位不到「${label}」这一行的下拉（${r}）`);

  // uni-app 的小下拉对 el.click() 常常不响应，必须真的派发鼠标事件（选省份当初也是这个坑）
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await page.waitForTimeout(1500);

  if (opts.search) {
    const box = page
      .locator('xpath=//*[contains(normalize-space(text()),"搜索关键词")]/following::input[1] | //input[contains(@placeholder,"搜索")]')
      .first();
    if (await box.isVisible().catch(() => false)) {
      await box.fill(opts.search).catch(() => {});
      await page.waitForTimeout(2000);
    }
  }

  // option 可以给多个写法：年份下拉里写的是全角的「（2025）」，不是「2025」
  const wanted = Array.isArray(option) ? option : [option];
  for (const cand of wanted) {
    // 倒着点：弹层是后插进 DOM 的，前面的同名文字多半是页面上本来就有的旧数据
    const all = page.locator(`text="${cand}"`);
    const n = await all.count().catch(() => 0);
    for (let i = n - 1; i >= 0; i--) {
      if (!(await all.nth(i).isVisible().catch(() => false))) continue;
      await all.nth(i).click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(900);
      const v = await page.evaluate(() => {
        const e = document.querySelector('[data-row-pick="1"]');
        return e ? (e.textContent || '').trim() : '';
      });
      if (v && v !== '请选择' && wanted.some((w) => v.includes(w))) return v;
    }
  }
  const seen = await page.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    return [...new Set(Array.from(document.querySelectorAll('*'))
      .filter((e) => e.children.length === 0 && vis(e))
      .map((e) => e.textContent.trim())
      .filter((t) => t && t.length <= 12))].slice(0, 60);
  }).catch(() => []);
  throw new Error(`「${label}」下拉里选不到「${wanted.join('/')}」。可见短文本：${seen.join('|')}`);
}

/**
 * 手工录一个组织型申请执行人（引入当事人库里没有它的时候）。
 *
 * 申请执行人表单的标签和被告表单不一样：是「单位名称 / 主要负责人姓名」，
 * 不是「名称 / 法定代表人」，所以不能直接复用 addDefendant。
 * 红星必填的有：单位名称、证照类型、统一社会信用代码、注册登记地国别或地区、
 * 住所地、主要负责人姓名/国别/证件类型/证件号码/联系电话，外加右下角那个「联系电话」。
 */
async function addApplicantOrg(page, info, phone) {
  const button = info.type === '法人' ? '添加法人' : '添加其他组织';
  log(`  申请执行人：${button} ${info.name}（常用联系人库里没有，手工录）`);
  await clickSectionButton(page, '申请执行人', button);
  await page.waitForTimeout(2500);

  const tryFill = async (labels, value, required) => {
    if (!value) return;
    for (const lbl of labels) {
      try { await fillLabeled(page, lbl, value); return; } catch (e) {}
    }
    if (required) throw new Error(`必填项「${labels[0]}」没填上`);
    log(`    「${labels[0]}」没填上，跳过`);
  };
  const tryPick = async (labels, option, required) => {
    for (const lbl of labels) {
      try { await pickLabeled(page, lbl, option); await dismissTreeCover(page); return; } catch (e) {}
      await dismissTreeCover(page);
    }
    if (required) throw new Error(`必填项「${labels[0]}」没选上`);
    log(`    「${labels[0]}」没选上，跳过`);
  };

  await tryFill(['单位名称', '名称'], info.name, true);
  await tryPick(['证照类型'], info.certType || '统一社会信用代码证', true);
  await tryFill(['统一社会信用代码'], info.creditCode, true);
  await tryPick(['注册登记地国别或地区'], '中国', true);
  await tryFill(['住所地'], info.address, true);
  await tryFill(['注册地/登记地', '注册地'], info.address, false);
  await tryFill(['主要负责人姓名', '法定代表人'], info.legalRep, true);
  await tryPick(['主要负责人国别或地区', '负责人国别或地区', '主要负责人国籍'], '中国', true);
  await tryPick(['主要负责人证件类型'], '居民身份证', true);
  await tryFill(['主要负责人证件号码'], info.legalRepIdNo, true);
  await tryFill(['主要负责人联系电话'], phone, true);
  await tryFill(['联系电话'], phone, true);

  await saveAndVerify(page, '申请执行人');
}

/**
 * 第 5 步（执行版）：完善案件信息。
 * 页面结构和一审的当事人区块是同一套组件，所以引入/添加/保存都能复用。
 *   申请执行人：引入当事人 → 示例保险；引入后「手机号码」是红色必填，平台不带
 *   被执行人：添加自然人，必填只有姓名（有身份证号、住所地就一并填上）
 *   执行请求：类型勾「金钱给付」，金额填标的总额
 * 每块都单独 try —— 执行页的字段还没实跑验证过，一处填不上不该把整轮拖挂，
 * 停下来截图交人工更划算。
 */
async function step5Zhixing(page, c) {
  log('第5步 完善案件信息（执行）');
  const problems = [];
  // 先把树形下拉遮罩的全局样式打上，免得哪一步下拉失败后留下的遮罩挡死后面所有点击
  await dismissTreeCover(page);

  const applicant = c.applicant || c.plaintiff || '示例保险股份有限公司某分公司';
  try {
    if (await page.locator(`text=${applicant}`).first().isVisible().catch(() => false)) {
      log('  申请执行人已存在，跳过');
    } else if (c.applicantInfo) {
      // 「常用联系人」库里只有示例保险、某保险苏州两条，换个分支（示例保险某支公司等）引不进来，
      // case.json 给 applicantInfo 就照被执行人的填法手工录。
      await addApplicantOrg(page, c.applicantInfo, c.applicantPhone || '13800000000');
    } else {
      log(`  申请执行人：引入当事人 → ${applicant}`);
      await clickSectionButton(page, '申请执行人', '引入当事人');
      await page.waitForTimeout(2500);
      await clickRowButton(page, applicant, '引入');
      await page.waitForTimeout(3000);
      // 引入之后是展开的编辑态，手机号码标红必填
      let phoneOk = false;
      for (const lbl of ['联系电话', '手机号码']) {
        try {
          await fillLabeled(page, lbl, c.applicantPhone || '13800000000');
          phoneOk = true;
          break;
        } catch (e) {}
      }
      if (!phoneOk) warn('    申请执行人的电话没填上，保存多半会被拦');
      await saveAndVerify(page, '申请执行人');
    }
  } catch (e) {
    problems.push(`申请执行人：${e.message}`);
    warn(`  申请执行人没弄成：${e.message}`);
    throw e;
  }

  const respondents = c.respondents || c.defendants || (c.defendant ? [c.defendant] : []);
  for (let i = 0; i < respondents.length; i++) {
    const d = respondents[i];
    const label = `被执行人${respondents.length > 1 ? i + 1 : ''}`;
    try {
      if (await page.locator(`text=${d.name}`).first().isVisible().catch(() => false)) {
        log(`  ${label} ${d.name} 已存在，跳过`);
        continue;
      }
      await addDefendant(page, d, label, '被执行人');
    } catch (e) {
      problems.push(`${label}：${e.message}`);
      warn(`  ${label} 没弄成：${e.message}`);
    throw e;
    }
  }

  // 代理人：一审只要补「被代理人 / 代理人类型 / 联系电话」，
  // 执行页多两个必填 —— 代理类型、现住址（2026-08-04 侦察记录）。
  // 自动带出来的电话是旧号 13900000000，必须改成 13800000000。
  try {
    log('  代理人：补全被代理人 / 代理类型 / 现住址 / 联系电话');
    await clickSectionButton(page, '代理人1', '编辑');
    await page.waitForTimeout(2500);
    await checkLabeled(page, '被代理人', applicant);
    await pickLabeled(page, '代理人类型', '执业律师');
    await dismissTreeCover(page);
    await pickLabeled(page, '国别或地区', '中国');
    // 「代理类型」是一般代理 / 特别授权，**按授权委托书上写的来**，猜不得。
    // case.json 不给就留空，让人工在预览前补 —— 填错了是实体问题，不是脚本问题。
    // 「代理类型」的选项是 法定代理 / 指定代理 / 委托代理 —— 是代理的性质，
    // **不是**一般授权/特别授权（我一开始就是这么猜错的，连挂三轮）。
    // 律师凭授权委托书出庭，一律「委托代理」，客观项，不用问当事人。
    // 授权权限（一般/特别）在这一页根本没有对应字段，别再找了。
    try {
      await pickLabeled(page, '代理类型', '委托代理');
    } catch (e) {
      throw new Error(`代理类型选不上：${e.message}`);
    }
    // 现住址红星必填，不填保存被拒「现住址不能为空」（眭晨案 2026-09-17）。
    // 律师代理一律填律所地址，case.json 给了 agentAddress 就用它的。
    try {
      await fillLabeled(page, '现住址', c.agentAddress || '某市某区某路1号某某大厦10楼');
    } catch (e) {
      throw new Error(`现住址填不上：${e.message}`);
    }
    // 这两个「是/否」也是红星必填，不填保存直接被拒。
    // 法律援助：商业代位求偿案件，一律「否」。
    // 同意电子送达：走的就是网上立案 + 送达地址确认书，选「是」。
    for (const [lbl, opt] of [['是否法律援助', '否'], ['同意电子送达', '是']]) {
      try {
        await pickRadioInOpenForm(page, lbl, opt);
        log(`    ${lbl} → ${opt}`);
      } catch (e) {
        throw new Error(`${lbl} 没选上：${e.message}`);
      }
    }
    await fillLabeled(page, '联系电话', c.agentPhone || '13800000000');
    await saveAndVerify(page, '代理人');
  } catch (e) {
    problems.push(`代理人：${e.message}`);
    warn(`  代理人没弄成：${e.message}`);
    throw e;
  }

  // 执行标的信息：执行理由（平台按前面填的内容自动生成、可改）、执行请求（照申请书）、
  // 执行标的类型（默认就勾着「金钱给付」）、申请执行标的的金额。
  // ⚠ 这一块**没有「保存」按钮**，靠「下一步」一起提交 —— 别调 saveAndVerify，
  //   它会去点上面当事人表单那个还开着的「保存」，报一堆牛头不对马嘴的错。
  const SEC = '执行标的信息';
  try {
    log(`  ${SEC}：金钱给付 / 金额 ${c.amount}`);
    // 前面若留了模态框（提示类的都是一个「确定」），先关掉，否则下面全点不动
    if (await clickTextIfVisible(page, '确定')) {
      log('    关掉了一个残留提示框');
      await page.waitForTimeout(1000);
    }

    // ⚠ 别点「自动提取执行请求」：它抽完会弹一个「自动提取执行请求提示」模态框，
    //   不关掉就盖住整页 —— 后面点「金钱给付」毫无反应、金额栏永远出不来（第五轮栽在这）。
    //   而且它还会把「执行标的类型」的勾清掉。我们本来就按申请书填，用不着它。
    if (c.request) {
      const r = await fillInSection(page, SEC, '执行请求', c.request).catch((e) => e.message);
      if (r === 'filled') log('    执行请求平台已自动带出，保留原文');
      else if (r !== 'ok') warn(`    执行请求没填上：${r}`);
    }

    // 执行理由平台会自动生成；生成了就别覆盖，没生成才用 case.json 的
    if (c.reason) {
      const r = await fillInSection(page, SEC, '执行理由', c.reason).catch((e) => e.message);
      if (r === 'filled') log('    执行理由平台已自动生成，保留原文');
      else if (r !== 'ok') warn(`    执行理由没填上：${r}`);
    }

    // 「申请执行标的的金额」这一栏**只有勾了「金钱给付」才渲染出来**，
    // 而点「自动提取执行请求」会把执行标的类型的勾清掉。
    // 直接读复选框状态不可靠（试过两版都判错，还把默认勾上的点没了），
    // 改成拿「金额栏出没出现」当判据：没出现就点一下类型，再看 —— 自带校验，点反了下一轮就补回来。
    let amtDone = false;
    for (let attempt = 1; attempt <= 3 && !amtDone; attempt++) {
      try {
        await fillInSection(page, SEC, /金额/, String(c.amount));
        amtDone = true;
      } catch (e) {
        if (attempt === 3) throw e;
        warn('    金额栏还没出现 → 说明「金钱给付」没勾上，点一下再看');
        await clickTextIfVisible(page, '金钱给付');
        await page.waitForTimeout(1500);
      }
    }
    log('    执行标的类型：金钱给付（已确认，金额栏已出现）');
  } catch (e) {
    problems.push(`${SEC}：${e.message}`);
    warn(`  ${SEC} 没弄成：${e.message}`);
    throw e;
  }

  if (problems.length) {
    warn('以下几块要人工补：');
    problems.forEach((p) => warn(`  · ${p}`));
  }
  return problems;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.cleanup && (!args.dir || (!args.court && !args.resume && !args.goto))) {
    console.error(
      '用法: node filing.js <案件目录> --court <法院全称> --province <省> [--city <市>]\n' +
      '            [--lawyers 张律师,李律师] [--cause <案由>] [--headless]\n' +
      '  --lawyers 按授权委托书里实际委托的律师填，决定引入哪个执业证分组，默认只有张律师\n' +
      '  直辖市（北京/上海/天津/重庆）不要传 --city\n' +
      '\n续跑一条已有草稿（跳过前三步，从它当前所在步骤往下走）：\n' +
      '  node filing.js <案件目录> --resume "<浏览器地址栏那条完整 URL>"\n' +
      '  node filing.js <案件目录> --resume <layyid> --fyid <法院代码>\n' +
      '\n申请执行（强制执行）立案：\n' +
      '  node filing.js <案件目录> --zhixing --court <法院全称> --province <省> --city <市> \\\n' +
      '       --casenum "（2026）苏0501民初1000号"\n' +
      '  案号也可以写进 case.json 的 casenum 字段\n' +
      '\n清理调试留下的空草稿（只删「待提交 + 名称暂无」）：\n' +
      '  node filing.js --cleanup'
    );
    process.exit(1);
  }

  let resolved = [];
  if (!args.cleanup) {
    if (!fs.existsSync(args.dir)) {
      console.error(`目录不存在: ${args.dir}`);
      process.exit(1);
    }
    const r = resolveFiles(args.dir, args.type === 'zhixing' ? SLOTS_ZHIXING : SLOTS);
    resolved = r.resolved;
    log(`案件目录: ${args.dir}`);
    log(`目录内 PDF: ${r.pdfs.join(', ')}`);
    if (r.unmatched && r.unmatched.length) {
      warn(`⚠ 以下 PDF 没归入任何材料槽位，确认是否要传：${r.unmatched.join('、')}`);
    }
    resolved.forEach((x) => log(`  ${x.slot} ← ${x.files.map((f) => path.basename(f)).join('、')}`));
    if (r.missingOptional && r.missingOptional.length) {
      warn(`以下槽位目录里没有对应 PDF（非必传，继续）：${r.missingOptional.join('、')}`);
    }
    if (r.missing.length && args.allowMissingId) {
      const stillMissing = r.missing.filter((s) => s !== '当事人身份证明');
      if (stillMissing.length !== r.missing.length) {
        warn('目录里没有被告身份证明，已按 --allow-missing-id 跳过本地预检（原告身份证明将在第 4c 步引入）');
      }
      r.missing = stillMissing;
    }
    if (r.missing.length) {
      console.error(`缺少必传材料: ${r.missing.join('、')}`);
      process.exit(1);
    }
  }

  let releaseProfile;
  try { releaseProfile = acquireProfileSession(PROFILE_DIR); }
  catch (e) { console.error(e.message); process.exit(1); }
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: args.headless,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  }).catch(e => { releaseProfile(); throw e; });
  const entry = context.pages()[0] || (await context.newPage());
  let page = entry;

  // 被 kill / Ctrl+C 时先把浏览器正常关掉，否则登录态不落盘，下次又要扫码
  let closing = false;
  const shutdown = async (sig, exitCode = 0) => {
    if (closing) return;
    closing = true;
    console.log(`\n▸ 收到 ${sig}，正在保存会话并关闭浏览器…`);
    try {
      await context.close();
    } catch (e) {
      console.error(`关闭本次浏览器失败：${e.message}`);
      exitCode = 1;
    } finally {
      releaseProfile();
    }
    process.exit(exitCode);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 案件要素来自 case.json（起诉状是扫描件，脚本读不出来，由我预先写好）
  const caseFile = args.cleanup ? null : path.join(args.dir, 'case.json');
  const caseData = caseFile && fs.existsSync(caseFile)
    ? JSON.parse(fs.readFileSync(caseFile, 'utf8'))
    : null;

  try {
    if (args.cleanup) {
      await ensureLoggedIn(entry);
      await cleanupDrafts(entry);
      await context.close();
      process.exit(0);
    }

    await ensureLoggedIn(entry);

    if (args.resume || args.goto) {
      // 续跑：跳过前三步，直接打开草稿
      page = entry;
      const at = await openDraft(page, buildResumeUrl(args.resume || args.goto, args.fyid, args.type));
      log(`草稿当前停在「${at}」`);
      if (at === '预览和提交') {
        await shootWholeStep(page, args.dir, '立案进度_预览和提交');
        log('草稿已在预览页，浏览器保持打开；最终提交由人工完成。');
        await new Promise(() => {});
      }

      if (at === '上传诉讼材料') {
        const pending = await pendingRequiredSlots(page).catch(() => []);
        if (pending.length) {
          warn(`材料未齐：${pending.join('、')}，补齐中`);
          if (args.type === 'zhixing') await step4cImportZhixing(page, args.plaintiffCert, args.lawyers, args.certs);
          else await step4cImportCommon(page, args.lawyers, { certs: args.certs, plaintiffCert: args.plaintiffCert });
          await step4bDeliveryAddress(page);
        }
        await goNext(page, args.type === 'zhixing' ? '申请执行人信息' : '标的信息');
      }
    } else if (args.type === 'zhixing') {
      // 申请执行：没有案由、没有立案方式，多一步「执行依据」
      page = await openWizard(context, entry, '申请执行');
      await step1SelectCourt(page, args.court, args.province, args.city);
      await step2NoticeZhixing(page);
      await step3Zhixing(page, args.casenum || (caseData && caseData.casenum), args.court);
      await step4Upload(page, resolved);
      await step4cImportZhixing(page, args.plaintiffCert, args.lawyers, args.certs);
      await step4bDeliveryAddress(page);

      const pendingZx = await pendingRequiredSlots(page).catch(() => []);
      if (pendingZx.length) warn(`仍有必传材料未备齐：${pendingZx.join('、')}`);

      await goNext(page, '被执行人');

    } else {
      page = await openWizard(context, entry);

      await step1SelectCourt(page, args.court, args.province, args.city);
      await step2Notice(page);
      await step3Cause(page, args.cause);
      await step4Upload(page, resolved);
      await step4cImportCommon(page, args.lawyers, { certs: args.certs, plaintiffCert: args.plaintiffCert });
      if (resolved.some((r) => r.slot === '送达地址确认书')) {
        log('第4b步 送达地址确认书已从目录直接上传，不再引入平台生成的');
      } else {
        await step4bDeliveryAddress(page);
      }
      await goNext(page, '标的信息');
    }

    const pending = await pendingRequiredSlots(page).catch(() => []);
    if (pending.length) warn(`仍有必传材料未备齐：${pending.join('、')}`);

    if (caseData) {
      if (args.type === 'zhixing') await step5Zhixing(page, caseData);
      else await step5CaseInfo(page, caseData);
    } else {
      warn(`没有 ${caseFile}，跳过第5步，完善案件信息请人工填写`);
    }

    const shots = await shootWholeStep(page, args.dir, args.type === 'zhixing' ? '执行立案进度_完善案件信息' : '立案进度_完善案件信息');

    console.log('');
    log('已停在「完善案件信息」，请逐字段核对截图');
    log(`截图（共 ${shots.length} 张，逐张核对）: ${shots.join('  ')}`);
    log(`向导 URL: ${page.url()}`);
    log('浏览器保持打开 —— 请手工填写当事人信息并提交。完成后按 Ctrl+C 结束脚本。');

    await new Promise(() => {}); // 挂起，别关浏览器
  } catch (err) {
    console.error('');
    console.error('✗ 出错:', err.message);
    if (err.code === 'EXECUTION_BASIS_NOT_EFFECTIVE') {
      if (page.__layyid) log(`保留草稿 layyid=${page.__layyid}${page.__fyid ? ` fyid=${page.__fyid}` : ''}`);
      else if (args.resume || args.goto) log(`保留草稿 ${args.resume || args.goto}${args.fyid ? ` fyid=${args.fyid}` : ''}`);
      console.error('本次执行立案尚未提交，等待用户与法院沟通后再按指示续办。');
      await shutdown('平台提示未生效', 2);
      return;
    }
    const shot = path.join(args.dir, '立案出错.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`已截图: ${shot}`);
    console.error('浏览器保持打开，可人工接管。按 Ctrl+C 结束。');
    await new Promise(() => {});
  }
})();
