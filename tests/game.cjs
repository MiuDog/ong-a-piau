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
	const expose = "window.__game = { game, state, config, startGame, throwGameCoin, finishGameTurn, selectGameCoin, planCpuTurn, makeGameBody, collisionRectangles, isGameCoinResting, sampleGlyph, balanceGameModel, handleGameContact, flushGameContacts, localPoint }; </script>";
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
		api.game.power = 0.8;
		let launched = false;
		// 生命周期 fixture 要取得可用投擲，再安排特定接觸；不可依賴舊版穿入疊牌出生。
		for (const [x, z] of [[0, 0], [0, 2.5], [-3, 2], [3, -2]]) {
			api.game.aim.set(x, 0, z);
			if (api.throwGameCoin()) { launched = true; break; }
		}
		requireCondition(launched, "合法且未受阻出手應建立真實投擲");
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
		api.game.power = 0.8;
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
		api.game.aim.set(-3, 0, 2);
		api.game.power = 1;
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
		// fixture 主動移位後必須喚醒，讓引擎重新建立接觸；不沿用移位前的支撐紀錄。
		for (const coin of [airborne, standing, airSupport]) {
			coin.supportSnapshot = null;
			coin.body.wakeUp();
		}
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
			const coverage = model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
			const budget = 4 * (0.75 - 0.5 * coverage) * power ** 2;
			const capped = Math.min(budget, 18 * model.mass, 0.72 / model.mass);
			near(kinetic + rotation + potential, capped, "高度、平移與旋轉必須共用同一實際投擲能量");
			requireCondition(body.velocity.length() <= 6 + 1e-9 && body.mass * body.velocity.length() <= 1.2 + 1e-9, "遊戲發射也不得突破速度或衝量上限");
			requireCondition(kinetic >= 0 && rotation >= 0 && potential >= -1e-9, "不可用負能量掩蓋超額發射");
		}
	}

	function sampleRawRectangle(columns, rows) {
		// 以解析矩形 alpha 取樣建立原始材料模型，覆蓋率由 fixture 尺寸決定。
		const original = CanvasRenderingContext2D.prototype.getImageData;
		function knownImage(x, y, width, height) {
			const image = original.call(this, x, y, width, height);
			image.data.fill(0);
			for (let row = 0; row < height * rows / 16; row++) {
				for (let col = 0; col < width * columns / 16; col++) image.data[(row * width + col) * 4 + 3] = 255;
			}
			return image;
		}
		CanvasRenderingContext2D.prototype.getImageData = knownImage;
		try {
			return api.sampleGlyph("田", "sans-serif");
		}
		finally {
			CanvasRenderingContext2D.prototype.getImageData = original;
		}
	}

	async function normalizedBalanceCheck() {
		let previousMass = 0, previousEnergy = Infinity, previousDamping = 0;
		for (const side of [1, 4, 8, 12, 16]) {
			await newGame();
			const coverage = side * side / 256;
			const raw = sampleRawRectangle(side, side);
			const original = JSON.stringify(raw);
			const balanced = api.balanceGameModel(raw);
			const mass = 0.18 + 0.12 * coverage, ratio = mass / raw.mass;
			near(raw.mass, coverage * api.config.density * api.config.thickness * api.config.size ** 2, "實驗室材料質量必須保持原公式");
			near(balanced.mass, mass, "遊戲規範化質量");
			for (const key of ["cx", "cz", "angle", "support", "offset", "step"]) near(balanced[key], raw[key], "規範化不得改變形狀與重心");
			for (const axis of ["x", "y", "z"]) near(balanced.inertia[axis], raw.inertia[axis] * ratio, "規範化必須一致縮放主慣量");
			near(balanced.stability, raw.stability * ratio, "規範化重力能障必須與質量同比例");
			requireCondition(balanced.cells.length === raw.cells.length, "規範化不得改變原佔據格數");
			for (let index = 0; index < raw.cells.length; index++) {
				const cell = balanced.cells[index], source = raw.cells[index];
				near(cell.mass, source.mass * ratio, "每格質量必須一致縮放");
				for (const key of ["x", "z", "row", "col", "alpha"]) near(cell[key], source[key], "規範化不得修改格位或覆蓋率");
			}
			requireCondition(JSON.stringify(raw) === original, "規範化不能原地修改共用實驗室模型");

			// 直接投擲規範化後的字形，量測完整能量，不拿進攻份額儀表當成實際效果。
			const coin = owned(0)[0];
			coin.model = balanced;
			requireCondition(api.selectGameCoin(coin.id), "規範化驗收必須使用合法持有枚");
			api.game.power = 1;
			requireCondition(api.throwGameCoin(), "規範化字形必須可以真正投擲");
			const body = coin.body, omega = body.quaternion.conjugate().vmult(body.angularVelocity);
			const rotation = 0.5 * (balanced.inertia.x * omega.x ** 2 + balanced.inertia.y * omega.y ** 2 + balanced.inertia.z * omega.z ** 2);
			const energy = 0.5 * body.mass * body.velocity.lengthSquared() + rotation + body.mass * api.config.gravity * (body.position.y - floorHeight);
			near(energy, 3 - 2 * coverage, "實際投擲能量必須等於未被上限截斷的進攻預算");
			near(body.mass, mass, "規範化質量必須直接作用於剛體");
			near(body.angularDamping, 0.08 + 0.24 * (0.25 + 0.5 * coverage), "高覆蓋率防守耗散必須直接作用於剛體");
			requireCondition(body.mass > previousMass && energy < previousEnergy && body.angularDamping > previousDamping, "密度上升必須提高質量與耗散、嚴格降低实际發射能量");
			requireCondition(body.velocity.length() <= 6 + 1e-9 && body.mass * body.velocity.length() <= 1.2 + 1e-9, "低密度亦不得突破速度與衝量上限");
			assertBodyMask(body, balanced);
			requireCondition(JSON.stringify(raw) === original, "建立及投擲遊戲剛體仍不得污染原材料模型");
			previousMass = body.mass;
			previousEnergy = energy;
			previousDamping = body.angularDamping;
		}
	}

	function kineticEnergy(body) {
		const omega = body.quaternion.conjugate().vmult(body.angularVelocity);
		return 0.5 * body.mass * body.velocity.lengthSquared() + 0.5 * (body.inertia.x * omega.x ** 2 + body.inertia.y * omega.y ** 2 + body.inertia.z * omega.z ** 2);
	}

	async function gameEdgeEnergyCheck() {
		let previousExtra = Infinity;
		for (const side of [1, 16]) {
			await newGame();
			const attacker = owned(0)[0], enemy = owned(1)[0];
			attacker.model = api.balanceGameModel(sampleRawRectangle(side, side));
			requireCondition(api.selectGameCoin(attacker.id), "攻方邊緣預算驗收必須合法選枚");
			api.game.power = 1;
			requireCondition(api.throwGameCoin(), "攻方必須先經真正投擲流程");
			const body = place(enemy, 3);
			body.velocity.set(0.2, 10, -0.1);
			body.angularVelocity.set(2, 1, -1);
			const point = api.localPoint(enemy.model.cells[0], enemy.model);
			point.y = api.config.thickness / 2;
			const offset = body.quaternion.vmult(point);
			const contact = {
				/* bi、bj：真實遊戲中的敵我剛體；ri、rj：已知世界力臂；getImpactVelocityAlongNormal：高入射fixture迫使能量上限生效。 */
				bi: body, bj: attacker.body, ri: offset, rj: offset,
				getImpactVelocityAlongNormal: () => 1000000
			};
			const event = { /* body：本次投出的攻方；contact：隔離遊戲能量上限的已知接觸條件。 */ body: attacker.body, contact };
			const before = kineticEnergy(body);
			const velocityBefore = body.velocity.clone(), positionBefore = body.position.clone(), orientationBefore = body.quaternion.clone();
			api.handleGameContact(body, event);
			const after = kineticEnergy(body), extra = after - before;
			const coverage = side * side / 256;
			near(extra, 1.2 * (0.75 - 0.5 * coverage) / 0.75, "遊戲邊緣額外能量必須由攻方進攻份額決定");
			const impulse = body.mass * (body.velocity.y - velocityBefore.y);
			requireCondition(impulse > 0 && impulse <= 0.8 + 1e-9, "遊戲助推的實際向上衝量必須受0.8Ns上限限制");
			near(body.position.distanceTo(positionBefore), 0, "助推不可直接改變位置");
			for (const axis of ["x", "y", "z", "w"]) near(body.quaternion[axis], orientationBefore[axis], "助推不可強制指定姿態或正背面");
			requireCondition(extra < previousExtra && enemy.assistUsed && enemy.hit, "較密攻方必須取得較低加成上限，並標記本枚已使用");
			api.handleGameContact(body, event);
			near(kineticEnergy(body), after, "同枚敵方在同次投擲不得重複取得助推");
			requireCondition(enemy.owner === 1, "邊緣助推不能直接代替最終判面或捕獲");
			previousExtra = extra;
		}
	}

	async function deferredContactCheck() {
		await newGame();
		const enemy = owned(1)[0];
		place(enemy);
		const attacker = beginThrow();
		place(attacker, 3);
		enemy.body.updateAABB();
		attacker.body.updateAABB();
		attacker.body.position.x += enemy.body.aabb.upperBound.x - attacker.body.aabb.lowerBound.x - 0.002;
		attacker.body.aabbNeedsUpdate = true;
		attacker.body.velocity.set(-3, 0, 0);
		const impulses = [], originalImpulse = enemy.body.applyImpulse;
		let callbacks = 0, savedContact = null;
		function observeImpulse(impulse, point) {
			// 只量測真正施力前後；不改衝量、位置、朝向或求解順序。
			const before = kineticEnergy(this), spin = this.angularVelocity.clone(), position = this.position.clone(), orientation = this.quaternion.clone();
			originalImpulse.call(this, impulse, point);
			impulses.push({ /* energy、spin：實際動能及角速增量，用於驗證求解後仍有助推。 */ energy: kineticEnergy(this) - before, spin: this.angularVelocity.distanceTo(spin) });
			near(this.position.distanceTo(position), 0, "真實助推不可傳送位置");
			for (const axis of ["x", "y", "z", "w"]) near(this.quaternion[axis], orientation[axis], "真實助推不可強制翻面");
		}
		enemy.body.applyImpulse = observeImpulse;
		function observeCollision(event) {
			if (event.body !== attacker.body) return;

			callbacks++;
			if (callbacks === 1) {
				requireCondition(impulses.length === 0 && !enemy.assistUsed, "碰撞回呼內不可提前施加會被求解器抵消的助推");
				savedContact = api.game.contacts.find((entry) => entry.body === enemy.body && entry.other === attacker.body);
				requireCondition(savedContact && Number.isFinite(savedContact.impact), "必須保存真實接觸及入射速度");
			}
		}
		enemy.body.addEventListener("collide", observeCollision);
		step(1);
		requireCondition(callbacks > 0 && enemy.hit && enemy.assistUsed, "真正碰撞必須於本步完成命中及助推");
		requireCondition(impulses.length === 1 && impulses[0].spin > 0.01, "求解後真正邊緣衝量必須產生非零角速回應");
		const coverage = attacker.model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
		requireCondition(impulses[0].energy <= 1.2 * (0.75 - 0.5 * coverage) / 0.75 + 1e-8, "真實求解後助推仍須遵守完整動能上限");
		requireCondition(api.game.contacts.length === 0 && enemy.owner === 1, "本步接觸佇列應清空且不能直接捕獲");
		step(90);
		requireCondition(impulses.length === 1, "後續真實碰撞不可重複助推同一敵枚");

		// 保留真正產生的接觸，重現重開發生於待處理接觸存在時的生命週期。
		api.game.contacts.push(savedContact);
		await newGame();
		requireCondition(api.game.contacts.length === 0, "重開必須丟棄舊局待處理接觸");
		api.game.contacts.push(savedContact);
		api.flushGameContacts();
		requireCondition(api.game.contacts.length === 0 && api.game.coins.every((coin) => !coin.body && !coin.hit && !coin.assistUsed), "過期接觸到達不可改變新局或遺留佇列");
		assertSix();
	}

	async function highBoundaryCheck() {
		for (const axis of ["x", "z"]) {
			await newGame();
			const coin = owned(0)[0], body = place(coin);
			body.position.y = 3;
			body.position[axis] = axis === "x" ? 3.8 : 2.3;
			body.velocity[axis] = 6;
			body.aabbNeedsUpdate = true;
			let contacts = 0;
			const observeWall = (event) => { if (api.game.walls.includes(event.body)) contacts++; };
			body.addEventListener("collide", observeWall);
			const limit = axis === "x" ? 5.6 : 4.1;
			for (let tick = 0; tick < 120; tick++) {
				step(1);
				body.updateAABB();
				requireCondition(body.aabb.upperBound[axis] <= limit + 0.08, "高處飛行薄片不得穿出可瞄準桌面的邊界");
			}
			requireCondition(contacts > 0, "高處邊界必須以真實剛體接觸阻擋，不以座標截斷代替");
			requireCondition(coin.owner === 0 && coin.body === body, "撞牆不得淘汰、捕獲或複製薄片");
			assertSix();
		}
	}

	async function spawnSafetyCheck() {
		for (const fromBoard of [false, true]) {
			await newGame();
			const selected = owned(0)[0], enemy = owned(1)[0];
			place(enemy);
			if (fromBoard) {
				for (const [index, coin] of owned(0).entries()) place(coin, -3 + 3 * index, -2.5);
			}
			requireCondition(api.selectGameCoin(selected.id), "出生拒絕驗收必須由合法選枚開始");
			api.game.aim.set(0, 0, 0);
			api.game.power = 0;
			const beforeBodies = api.game.coins.map((coin) => coin.body), worldBodies = [...api.state.world.bodies];
			const beforeState = JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.hit, coin.assistUsed, coin.body?.position, coin.body?.quaternion]));
			const turn = api.game.turn, current = api.game.current, thrownId = api.game.thrownId;
			requireCondition(!api.throwGameCoin(), "零能量出生點被敵枚占滿時必須拒絕，不能深度穿入");
			requireCondition(api.game.status === "ready" && api.game.turn === turn && api.game.current === current && api.game.thrownId === thrownId, "拒絕出生不得開始或消耗回合");
			requireCondition(api.game.coins.every((coin, index) => coin.body === beforeBodies[index]), "拒絕出生不得刪除或替換任何桌面剛體");
			requireCondition(api.state.world.bodies.length === worldBodies.length && worldBodies.every((body) => api.state.world.bodies.includes(body)), "拒絕後物理世界必須維持原物件集合");
			requireCondition(JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.hit, coin.assistUsed, coin.body?.position, coin.body?.quaternion])) === beforeState, "拒絕出生不得更改持有、接觸旗標或姿態");
			assertSix();
		}

		await newGame();
		const enemy = owned(1)[0];
		const obstacle = place(enemy, -2, 2);
		obstacle.position.y = 0.5;
		obstacle.aabbNeedsUpdate = true;
		const selected = owned(0)[0];
		requireCondition(api.selectGameCoin(selected.id), "安全出生應接受合法手中枚");
		api.game.aim.set(0, 0, 0);
		api.game.power = 1;
		requireCondition(api.throwGameCoin(), "仍有不重疊方向時應尋找可用出生位置");
		selected.body.updateAABB();
		obstacle.updateAABB();
		const overlap = ["x", "y", "z"].every((axis) => Math.min(selected.body.aabb.upperBound[axis], obstacle.aabb.upperBound[axis]) > Math.max(selected.body.aabb.lowerBound[axis], obstacle.aabb.lowerBound[axis]));
		requireCondition(!overlap, "成功出生的實際碰撞 AABB 不得與既有疊牌重疊");
		for (const axis of ["x", "z"]) {
			const limit = axis === "x" ? 5.6 : 4.1;
			requireCondition(selected.body.aabb.lowerBound[axis] >= -limit && selected.body.aabb.upperBound[axis] <= limit, "成功出生的整枚碰撞形狀必須在牆內");
		}
		const body = selected.body, energy = kineticEnergy(body) + body.mass * api.config.gravity * (body.position.y - floorHeight);
		const coverage = selected.model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
		near(energy, 3 - 2 * coverage, "另尋安全出生方向不可增添高度、平移或旋轉能量");
		assertSix();
	}

	function recordGroundSupport(coin) {
		// 暫停自動睡眠，先讓真正接觸方程穩定；不由測試偽造支撐紀錄。
		coin.body.allowSleep = false;
		step(120);
		requireCondition(api.isGameCoinResting(coin), "必須先由真實接觸建立穩定桌面支撐");
		coin.body.allowSleep = true;
		coin.body.sleep();
		step(6);
	}

	async function sleepingSupportCheck() {
		await newGame();
		const natural = owned(0)[0];
		place(natural, -3);
		// 對局本身已啟用自動睡眠，直接驗證產品設定及真正入睡轉折，不再由 fixture 代為開啟。
		requireCondition(api.state.world.allowSleep === true, "開始對局必須啟用其自然睡眠策略");
		for (let tick = 0; tick < 1200 && natural.body.sleepState !== 2; tick++) {
			step(1);
			api.isGameCoinResting(natural);
		}
		requireCondition(natural.body.sleepState === 2, "正常落地薄片必須能自然睡眠");
		step(6);
		requireCondition(api.isGameCoinResting(natural), "自然入睡的最後微小位移不能造成永久未停止");

		await newGame();
		const thrown = beginThrow();
		place(thrown, 4, 3);
		const enemy = owned(1)[0];
		place(enemy, -4);
		backface(enemy);
		recordGroundSupport(enemy);
		const touchesEnemy = (contact) => contact.bi === enemy.body || contact.bj === enemy.body;
		requireCondition(!api.state.world.contacts.some(touchesEnemy), "fixture 必須確實重現睡眠剛體接觸方程被省略");
		requireCondition(api.isGameCoinResting(enemy), "曾真實接地且姿態未變的睡眠薄片仍應判為停止");
		enemy.body.position.y = 5;
		enemy.body.aabbNeedsUpdate = true;
		step(1);
		requireCondition(!api.isGameCoinResting(enemy), "移至空中後舊接地紀錄必須失效");
		enemy.hit = true;
		api.finishGameTurn(true);
		requireCondition(enemy.owner === 1 && enemy.body, "睡眠且空中的背面枚不可因舊紀錄被捕獲");
		assertSix();
	}

	async function supportedStackRemovalCheck() {
		await newGame();
		const thrown = beginThrow();
		place(thrown, 4, 3);
		const lower = owned(1)[0], upper = owned(0).find((coin) => coin !== thrown);
		place(lower);
		backface(lower);
		place(upper);
		upper.body.position.y += api.config.thickness + 0.003;
		for (const coin of [lower, upper, thrown]) coin.body.allowSleep = false;
		step(360);
		for (const coin of [lower, upper, thrown]) {
			requireCondition(api.isGameCoinResting(coin), "疊放 fixture 必須先由真實接觸穩定支撐");
			coin.body.allowSleep = true;
			coin.body.sleep();
		}
		step(6);
		requireCondition(api.isGameCoinResting(upper), "未變姿態的睡眠上層必須保留已確認的支撐路徑");
		lower.hit = true;
		api.finishGameTurn();
		requireCondition(lower.owner === 0 && lower.body === null, "下層敵枚應經正常背面捕獲而移除");
		requireCondition(upper.body && upper.body.sleepState !== 2, "捕獲支撐枚後必須喚醒仍在桌面的上層");
		requireCondition(upper.supportSnapshot == null, "捕獲後不得保留引用已移除支撐的快取");
		requireCondition(!api.isGameCoinResting(upper), "失去下層後的上層不能沿舊路徑判為接地");
		assertSix();
	}

	async function newThrowInvalidatesSupportCheck() {
		await newGame();
		const friendly = owned(0)[0], enemy = owned(1)[0];
		place(friendly, -4);
		place(enemy, 4);
		for (const coin of [friendly, enemy]) coin.body.allowSleep = false;
		step(120);
		for (const coin of [friendly, enemy]) {
			requireCondition(api.isGameCoinResting(coin), "新投擲前必須先記錄真實桌面支撐");
			coin.body.allowSleep = true;
			coin.body.sleep();
		}
		step(6);
		beginThrow();
		for (const coin of [friendly, enemy]) {
			requireCondition(coin.body.sleepState !== 2, "新投擲必須喚醒所有仍在桌面的薄片");
			requireCondition(coin.supportSnapshot == null, "新投擲必須重新驗證支撐，不可沿用前回合快取");
		}
		assertSix();
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
	await check("遊戲規範化保留原模型、密度攻防實際單調", normalizedBalanceCheck);
	await check("遊戲邊緣能量隨攻方進攻份額下降且每枚只加一次", gameEdgeEnergyCheck);
	await check("真實接觸求解後助推、一次性與重開佇列清理", deferredContactCheck);
	await check("高處真實邊界接觸保留薄片及所有權", highBoundaryCheck);
	await check("安全出生保留能量、受阻拒絕不改原對局", spawnSafetyCheck);
	await check("睡眠接觸省略後仍停止、移至空中快取失效", sleepingSupportCheck);
	await check("睡眠疊放支撐、捕獲下層後喚醒與失效", supportedStackRemovalCheck);
	await check("新投擲清除前回合支撐紀錄並喚醒桌面枚", newThrowInvalidatesSupportCheck);
	return { /* passed：實際通過的流程；failures：逐項失敗原因，禁止用跳過取代修正。 */ passed, failures };
}

// 必須以非零退出碼保留錯誤，不把測試寫完當成遊戲驗收成功。
main().catch((error) => { console.error(error); process.exitCode = 1; });
