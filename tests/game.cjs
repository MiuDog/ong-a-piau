// 遊戲規則測試使用真正產品頁及物理世界；保留原物理與攻防測試的獨立預期。
const { chromium } = require("C:/Users/ASUS_TUF/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");

async function main() {

	// 固定物理步進，避免瀏覽器動畫與驗收同時修改世界。
	const browser = await chromium.launch({ /* executablePath：既有 Chrome；headless：背景驗收不搶桌面。 */ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
	try {
		const page = await browser.newPage();
		const errors = [];
		const recordError = (error) => errors.push(error.message);
		await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
		page.on("pageerror", recordError);
		await page.route("http://127.0.0.1:5173/", instrumentRoute);
		await page.goto("http://127.0.0.1:5173/");
		await page.waitForFunction(() => window.__game?.state.world != null, null, { /* timeout：外部字體／模組載入容許時間；polling：不用已停用的動畫。 */ timeout: 45000, polling: 100 });
		const result = await page.evaluate(runChecks);
		assert.deepEqual(errors, [], "遊戲頁不得發生執行錯誤");
		assert.deepEqual(result.failures, [], result.failures.join("\n"));
		console.log(JSON.stringify(result, null, 2));
	}
	finally {
		await browser.close();
	}
}

async function instrumentRoute(route) {

	// 只暴露測試接點，不更改規則、判面或碰撞處理。
	const response = await route.fetch();
	const expose = "window.__game = { game, state, config, startGame, throwGameCoin, finishGameTurn, selectGameCoin, planCpuTurn, makeGameBody, collisionRectangles, isGameCoinResting }; </script>";
	const html = (await response.text()).replace("</script>", expose);
	await route.fulfill({ /* response：保留原回應；body：唯此測試可見的接點。 */ response, body: html });
}

async function runChecks() {

	const api = window.__game;
	const passed = [], failures = [];
	const floorHeight = api.config.thickness / 2 + 0.003;

	function requireCondition(value, label) {
		if (!value) throw new Error(label);
	}

	function near(actual, expected, label) {
		if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-8 * Math.max(1, Math.abs(expected))) throw new Error(`${label}: ${actual} != ${expected}`);
	}

	function assertPartition(model, rectangles) {
		// 逐格重建矩形聯集，獨立檢查漏格、填洞與重疊，不以矩形數量代表形狀正確。
		const expected = new Set(model.cells.map((cell) => `${cell.row},${cell.col}`));
		const actual = new Set();
		for (const rectangle of rectangles) {
			for (const key of ["row", "col", "width", "height"]) near(rectangle[key], Math.round(rectangle[key]), "碰撞邊界必須對齊原網格");
			requireCondition(rectangle.width > 0 && rectangle.height > 0, "合併碰撞盒不可為空或負尺寸");
			for (let row = rectangle.row; row < rectangle.row + rectangle.height; row++) {
				for (let col = rectangle.col; col < rectangle.col + rectangle.width; col++) {
					const key = `${row},${col}`;
					requireCondition(expected.has(key), `碰撞合併不可填入原字形空白 ${key}`);
					requireCondition(!actual.has(key), `碰撞合併不可重疊 ${key}`);
					actual.add(key);
				}
			}
		}
		requireCondition(actual.size === expected.size, "碰撞合併不得遺失原字形筆畫");
	}

	function assertBodyMask(body, model) {
		// 從真正引擎碰撞盒反推原網格，不能只驗證合併清單卻放過建立剛體時的座標錯誤。
		const rectangles = [];
		for (let index = 0; index < body.shapes.length; index++) {
			const extent = body.shapes[index].halfExtents;
			requireCondition(extent, "字形物理必須由保留輪廓的薄方盒組成");
			const center = body.quaternion.vmult(body.shapeOffsets[index]);
			const orientation = body.quaternion.mult(body.shapeOrientations[index]);
			near(Math.abs(orientation.w), 1, "初始世界碰撞盒必須保持原字形網格朝向");
			near(extent.y * 2, api.config.thickness, "合併不得改變厚度");
			const width = extent.x * 2 / model.step, height = extent.z * 2 / model.step;
			rectangles.push({ /* row、col：從世界相對重心位置還原的起始格；width、height：引擎盒尺寸還原格數。 */ row: (center.z + model.cz + api.config.size / 2) / model.step - height / 2, col: (center.x + model.cx + api.config.size / 2) / model.step - width / 2, width, height });
		}
		for (const rectangle of rectangles) {
			for (const key of ["row", "col", "width", "height"]) {
				near(rectangle[key], Math.round(rectangle[key]), "引擎盒邊界必須對齊原網格");
				rectangle[key] = Math.round(rectangle[key]);
			}
		}
		assertPartition(model, rectangles);
	}

	async function check(label, action) {
		try {
			await action();
			passed.push(label);
		}
		catch (error) {
			failures.push(`${label}: ${error.message}`);
		}
	}

	async function newGame(mode = "local") {
		// 從真正設定流程建立六枚，避免由測試自行製造初始所有權。
		document.getElementById("mode").value = mode;
		for (const player of [1, 2]) {
			document.getElementById(`p${player}-name`).value = `玩家${player}`;
			const font = document.getElementById(`p${player}-font`);
			font.value = font.options[0].value;
			for (let slot = 0; slot < 3; slot++) document.getElementById(`p${player}-text-${slot}`).value = "口";
		}
		await api.startGame();
		requireCondition(api.game.active && api.game.status === "ready", "設定完成必須進入可出手對局");
	}

	function owned(owner) {
		return api.game.coins.filter((coin) => coin.owner === owner);
	}

	function assertSix() {
		requireCondition(api.game.coins.length === 6 && new Set(api.game.coins.map((coin) => coin.id)).size === 6, "六個唯一身份必須持續存在");
		requireCondition(owned(0).length + owned(1).length === 6, "手中與桌面合计必須為六");
	}

	function place(coin, x = 0, z = 0) {
		// 只安排已有薄片的物理位置；不修改 owner、id、model 或字體。
		if (!coin.body) {
			coin.body = api.makeGameBody(coin.model, api.game.aim.clone().set(x, floorHeight, z));
			api.state.world.addBody(coin.body);
		}
		const body = coin.body;
		body.position.set(x, floorHeight, z);
		body.quaternion.setFromEuler(0, -coin.model.angle, 0);
		body.velocity.set(0, 0, 0);
		body.angularVelocity.set(0, 0, 0);
		body.updateInertiaWorld(true);
		body.aabbNeedsUpdate = true;
		body.wakeUp();
		return body;
	}

	function backface(coin) {
		coin.body.quaternion.setFromEuler(Math.PI, -coin.model.angle, 0);
		coin.body.updateInertiaWorld(true);
		coin.body.aabbNeedsUpdate = true;
	}

	function step(ticks = 360) {
		for (let tick = 0; tick < ticks; tick++) api.state.world.step(1 / 120);
	}

	function beginThrow() {
		const player = api.game.current;
		const candidate = owned(player).find((coin) => coin.body === null) || owned(player)[0];
		requireCondition(api.selectGameCoin(candidate.id), "合法枚應可選取");
		api.game.aim.set(0, 0, 0);
		api.game.power = 0.4;
		requireCondition(api.throwGameCoin(), "合法出手應建立真實投擲");
		requireCondition(candidate.body && api.state.world.bodies.includes(candidate.body), "投出枚必須加入物理世界");
		return candidate;
	}

	async function setupPriorityCheck() {
		await newGame();
		assertSix();
		requireCondition(owned(0).length === 3 && owned(1).length === 3 && api.game.coins.every((coin) => coin.body === null), "每人必須各有三枚手中枚");
		const board = owned(0)[0], opponent = owned(1)[0];
		place(board, -4);
		requireCondition(!api.selectGameCoin(board.id), "有手中枚時不可撿自己的桌面枚");
		requireCondition(!api.selectGameCoin(opponent.id), "不可選取對手枚");
		const thrown = beginThrow();
		requireCondition(thrown !== board, "手中優先不能被選取狀態繞過");
		requireCondition(!api.throwGameCoin(), "模擬中不可重複投擲");
		api.finishGameTurn();
		requireCondition(api.game.status === "simulating" && api.game.current === 0, "仍在飛行的投擲不能經一般結算提前換人");
		assertSix();
	}

	async function boardReuseCheck() {
		await newGame();
		for (const [index, coin] of owned(0).entries()) place(coin, -4 + index * 4);
		const selected = owned(0)[1], oldBody = selected.body;
		requireCondition(api.selectGameCoin(selected.id), "沒有手中枚時可選己方桌面枚");
		api.game.power = 0.4;
		requireCondition(api.throwGameCoin(), "己方桌面枚應可重投");
		requireCondition(selected.body && api.state.world.bodies.includes(selected.body), "重投後同枚必須仍在世界");
		if (selected.body !== oldBody) requireCondition(!api.state.world.bodies.includes(oldBody), "換剛體時必須移除舊剛體");
		api.finishGameTurn(true);
		requireCondition(api.game.current === 1 && api.game.status === "ready", "未決超時應交給下一人而非卡住回合");
		assertSix();
	}

	async function realCollisionCaptureCheck() {
		await newGame();
		const enemy = owned(1)[0], enemyModel = enemy.model;
		const enemyId = enemy.id, enemyText = enemy.text, enemyFont = enemy.font;
		place(enemy);
		backface(enemy);
		const thrown = beginThrow();
		place(thrown, 3);
		enemy.body.updateAABB();
		thrown.body.updateAABB();
		thrown.body.position.x += enemy.body.aabb.upperBound.x - thrown.body.aabb.lowerBound.x - 0.02;
		thrown.body.aabbNeedsUpdate = true;
		thrown.body.velocity.set(-0.4, 0, 0);
		let contacts = 0;
		const recordContact = (event) => { if (event.body === enemy.body) contacts++; };
		thrown.body.addEventListener("collide", recordContact);
		step(480);
		requireCondition(contacts > 0 && enemy.hit, "必須經真實剛體碰撞標記敵方受影響");
		requireCondition(api.isGameCoinResting(enemy), "捕獲前必須有真實穩定支撐");
		const previousBody = enemy.body;
		api.finishGameTurn();
		requireCondition(enemy.owner === 0 && enemy.body === null, "命中後背面穩定敵枚應進攻方手中");
		requireCondition(enemy.id === enemyId && enemy.text === enemyText && enemy.font === enemyFont && enemy.model === enemyModel, "捕獲必須保留身份、字體及完整物理模型");
		requireCondition(!api.state.world.bodies.includes(previousBody), "捕獲後桌面舊剛體必須移除");
		requireCondition(api.game.current === 1 && api.game.status === "ready", "捕獲判給出手者後才交替回合");
		assertSix();

		// 下一輪再投出剛捕獲的同枚，確認保留模型不只停留在資料欄位。
		beginThrow();
		api.finishGameTurn(true);
		requireCondition(api.selectGameCoin(enemy.id) && api.throwGameCoin(), "捕獲枚在攻方下一回合必須可再次使用");
		requireCondition(enemy.body && Math.abs(enemy.body.mass - enemyModel.mass) < 1e-10, "重投捕獲枚必須沿用原質量");
		for (const axis of ["x", "y", "z"]) requireCondition(Math.abs(enemy.body.inertia[axis] - enemyModel.inertia[axis]) < 1e-10, "重投捕獲枚必須沿用原主慣量");
		assertBodyMask(enemy.body, enemyModel);
		assertSix();
	}

	async function exclusionCheck() {
		await newGame();
		const enemies = owned(1);
		for (let index = 0; index < enemies.length; index++) place(enemies[index], -4 + index * 4, -3);
		backface(enemies[0]);
		backface(enemies[2]);
		const thrown = beginThrow();
		place(thrown, 0, 3);
		backface(thrown);
		step();
		// 第一枚背面但未命中，第二枚命中仍正面，第三枚命中但仍移動；自己投出的背面枚也不可捕獲。
		enemies[0].hit = false;
		enemies[1].hit = true;
		enemies[2].hit = true;
		enemies[2].body.angularVelocity.set(0.5, 0, 0);
		thrown.hit = true;
		api.finishGameTurn(true);
		requireCondition(enemies.every((coin) => coin.owner === 1 && coin.body), "未命中、正面與仍旋轉敵枚不得捕獲");
		requireCondition(thrown.owner === 0 && thrown.body, "自投枚即使背面也不可因己方動作入手");
		assertSix();

		await newGame();
		const airborne = owned(1)[0], standing = owned(1)[1], airSupport = owned(1)[2];
		place(airborne, -4);
		backface(airborne);
		place(standing, 4);
		place(airSupport, -4, -3);
		const projectile = beginThrow();
		place(projectile, 0, 3);
		step();
		airborne.body.position.y = 5 + api.config.thickness - 0.001;
		airborne.body.aabbNeedsUpdate = true;
		airSupport.body.position.set(-4, 5, 0);
		airSupport.body.aabbNeedsUpdate = true;
		standing.body.quaternion.setFromEuler(Math.PI / 2, 0, 0);
		standing.body.updateAABB();
		standing.body.position.y += -0.001 - standing.body.aabb.lowerBound.y;
		standing.body.aabbNeedsUpdate = true;
		step(1);
		for (const coin of [airborne, standing, airSupport]) {
			coin.hit = true;
			coin.body.velocity.set(0, 0, 0);
			coin.body.angularVelocity.set(0, 0, 0);
		}
		requireCondition(!api.isGameCoinResting(airborne) && !api.isGameCoinResting(airSupport), "空中相互接觸的薄片不能循環推論為桌面支撐");
		requireCondition(api.isGameCoinResting(standing), "側立 fixture 必須取得靜止桌面支撐，不能只靠空中拒判");
		api.finishGameTurn(true);
		requireCondition(airborne.owner === 1 && standing.owner === 1, "空中瞬停或側立不可因超時自動捕獲");
		assertSix();
	}

	async function multiAndWinCheck() {
		await newGame();
		const enemies = owned(1);
		for (let index = 0; index < enemies.length; index++) {
			place(enemies[index], -4 + index * 4, -3);
			backface(enemies[index]);
		}
		const thrown = beginThrow();
		place(thrown, 0, 3);
		step();
		enemies[0].hit = enemies[1].hit = true;
		enemies[2].hit = false;
		api.finishGameTurn();
		requireCondition(owned(0).length === 5 && owned(1).length === 1, "同次投擲必須可捕獲多枚");
		requireCondition(api.game.status === "ready" && api.game.winner == null, "五比一不能結束比賽");
		requireCondition(enemies[0].body === null && enemies[1].body === null, "所有捕獲枚必須進手中");
		assertSix();

		await newGame();
		const finalEnemies = owned(1);
		for (let index = 0; index < finalEnemies.length; index++) {
			place(finalEnemies[index], -4 + index * 4, -3);
			backface(finalEnemies[index]);
		}
		const finalThrow = beginThrow();
		place(finalThrow, 0, 3);
		step();
		for (const coin of finalEnemies) coin.hit = true;
		api.finishGameTurn();
		requireCondition(owned(0).length === 6 && owned(1).length === 0 && api.game.status === "won" && api.game.winner === 0, "僅六比零才宣告正確攻方勝利");
		requireCondition(!api.throwGameCoin(), "已結束比賽不可繼續投擲");
		assertSix();
	}

	async function cpuAndRestartCheck() {
		await newGame();
		const enemies = owned(1);
		place(enemies[0], 0, -2);
		const originalOwners = api.game.coins.map((coin) => coin.owner).join(",");
		const plan = api.planCpuTurn();
		const planned = api.game.coins.find((coin) => coin.id === plan.coinId);
		requireCondition(planned && planned.owner === api.game.current && planned.body === null, "電腦規劃必須遵守手中優先與所有權");
		requireCondition(Number.isFinite(plan.power) && plan.power >= 0 && plan.power <= 1, "電腦力度必須合法");
		requireCondition(plan.aim && Number.isFinite(plan.aim.x) && Number.isFinite(plan.aim.z), "電腦必須提供可用瞄準點");
		requireCondition(api.game.coins.map((coin) => coin.owner).join(",") === originalOwners, "電腦規劃不能直接改捕獲結果");
		const thrown = beginThrow();
		const oldBodies = api.game.coins.map((coin) => coin.body).filter(Boolean);
		const oldEpoch = api.game.epoch;
		await newGame();
		requireCondition(api.game.epoch > oldEpoch && api.game.current === 0, "重開必須建立新世代並回到首位玩家");
		requireCondition(api.game.coins.every((coin) => coin.body === null), "重開必須重建六枚手牌");
		requireCondition(oldBodies.every((body) => !api.state.world.bodies.includes(body)), "重開必須移除上一局物理物件");
		requireCondition(thrown.body === null || !api.state.world.bodies.includes(thrown.body), "舊投出枚不能滯留在世界");
		api.finishGameTurn(true);
		requireCondition(api.game.current === 0 && api.game.status === "ready", "舊回合結算不能續寫新對局");
		assertSix();
	}

	function finishWithQueuedTimers() {
		// 只保存本次結算安排的真正計時器回呼，讓測試能明確控制新舊回合到達順序。
		const original = window.setTimeout, queued = [];
		window.setTimeout = (callback, delay, ...args) => { queued.push(() => callback(...args)); return 0; };
		try {
			api.finishGameTurn(true);
		}
		finally {
			window.setTimeout = original;
		}
		return queued;
	}

	async function cpuTimerCheck() {
		await newGame("cpu");
		beginThrow();
		const queued = finishWithQueuedTimers();
		requireCondition(queued.length > 0 && api.game.current === 1, "人類回合結束應排程電腦回合");
		for (const callback of queued) await callback();
		requireCondition(api.game.status === "simulating", "電腦回呼必須啟動相同真實投擲流程");
		const cpuCoin = api.game.coins.find((coin) => coin.id === api.game.thrownId);
		requireCondition(cpuCoin && cpuCoin.owner === 1 && cpuCoin.body && api.state.world.bodies.includes(cpuCoin.body), "電腦必須投出自己的真實字形剛體");
		requireCondition(owned(0).length === 3 && owned(1).length === 3, "電腦啟動投擲不能直接奪枚或指定勝負");
		api.finishGameTurn(true);
		requireCondition(api.game.current === 0, "電腦回合結束應交還人類");
		beginThrow();
		const stale = finishWithQueuedTimers();
		requireCondition(stale.length > 0, "必須保留一個待到達的舊電腦回呼");
		await newGame("local");
		for (const callback of stale) await callback();
		requireCondition(api.game.current === 0 && api.game.status === "ready" && api.game.coins.every((coin) => coin.body === null), "舊CPU回呼到達後，新對局仍應保持原狀");
		assertSix();
	}

	async function mergedGeometryCheck() {
		const masks = [["11111", "10001", "10001", "10001", "11111"], ["110011", "110011", "000000", "011100", "011100", "001100"], ["1"], ["1111", "1111", "1111"]];
		for (const mask of masks) {
			const cells = [];
			for (let row = 0; row < mask.length; row++) {
				for (let col = 0; col < mask[row].length; col++) {
					if (mask[row][col] === "1") cells.push({ /* row、col：獨立二元遮罩中的佔據格，不從產品合併結果反推。 */ row, col });
				}
			}
			const model = { /* cells：測試空洞、斷行與變寬的原始佔據格。 */ cells };
			const rectangles = api.collisionRectangles(model);
			assertPartition(model, rectangles);
			if (mask === masks[3]) requireCondition(rectangles.length === 1, "完整連續矩形應合併為單盒，否則未解決逐像素接觸成本");
		}
		await newGame();
		for (const coin of api.game.coins) {
			const body = api.makeGameBody(coin.model, api.game.aim.clone().set(0, floorHeight, 0));
			assertBodyMask(body, coin.model);
			near(body.mass, coin.model.mass, "碰撞合併後質量仍取原像素積分");
			for (const axis of ["x", "y", "z"]) near(body.inertia[axis], coin.model.inertia[axis], "碰撞合併後仍使用原主慣量");
		}
	}

	async function gameEnergyCheck() {
		for (const power of [0, 0.4, 1]) {
			await newGame();
			const coin = owned(0)[0], model = coin.model;
			requireCondition(api.selectGameCoin(coin.id), "能量驗收必須由合法選枚進入");
			api.game.power = power;
			api.game.aim.set(0, 0, 0);
			requireCondition(api.throwGameCoin(), "能量驗收必須建立實際投擲剛體");
			const body = coin.body;
			const omega = body.quaternion.conjugate().vmult(body.angularVelocity);
			const kinetic = 0.5 * body.mass * body.velocity.lengthSquared();
			const rotation = 0.5 * (model.inertia.x * omega.x ** 2 + model.inertia.y * omega.y ** 2 + model.inertia.z * omega.z ** 2);
			const potential = body.mass * api.config.gravity * (body.position.y - floorHeight);
			const coverage = model.mass / (api.config.density * api.config.thickness * api.config.size ** 2);
			const budget = 6.4 * (0.75 - 0.5 * coverage) * power ** 2;
			const capped = Math.min(budget, 18 * model.mass, 0.72 / model.mass);
			near(kinetic + rotation + potential, capped, "高度、平移與旋轉必須共用同一實際投擲能量");
			requireCondition(body.velocity.length() <= 6 + 1e-9 && body.mass * body.velocity.length() <= 1.2 + 1e-9, "遊戲發射也不得突破速度或衝量上限");
			requireCondition(kinetic >= 0 && rotation >= 0 && potential >= -1e-9, "不可用負能量掩蓋超額發射");
		}
	}

	await check("六枚開局、所有權與手中優先", setupPriorityCheck);
	await check("己方桌面枚重投、回合交替", boardReuseCheck);
	await check("真實命中到捕獲、物性保留與清理", realCollisionCaptureCheck);
	await check("未命中／正面／動態／空中／自投排除", exclusionCheck);
	await check("多枚捕獲、五比一繼續、六比零勝利", multiAndWinCheck);
	await check("合法電腦規劃與重開世代清理", cpuAndRestartCheck);
	await check("電腦真實投擲與過期回呼隔離", cpuTimerCheck);
	await check("合併碰撞盒保留原遮罩、空洞、質量與慣量", mergedGeometryCheck);
	await check("遊戲投擲平移、旋轉、高度共用有界預算", gameEnergyCheck);
	return { /* passed：實際通過的流程；failures：逐項失敗原因，禁止用跳過取代修正。 */ passed, failures };
}

// 必須以非零退出碼保留錯誤，不把測試寫完當成遊戲驗收成功。
main().catch((error) => { console.error(error); process.exitCode = 1; });
