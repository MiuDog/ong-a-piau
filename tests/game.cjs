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
		console.log(JSON.stringify(result, null, 2));
		await pointerUiCheck(page);
		await flickSpeedCheck(page);
		await perimeterDragCheck(page);
		await cameraResizeCheck(page);
		assert.deepEqual(errors, [], "遊戲頁不得發生執行錯誤");
		assert.deepEqual(result.failures, [], result.failures.join("\n"));
	}
	finally {
		await browser.close();
	}
}

async function instrumentRoute(route) {

	// 只暴露測試接點，不更改規則、判面或碰撞處理。
	const response = await route.fetch();
	const expose = "window.__game = { game, state, config, startGame, throwGameCoin, finishGameTurn, selectGameCoin, planCpuTurn, makeGameBody, makeGlyphMesh, collisionRectangles, isGameCoinResting, sampleGlyph, balanceGameModel, glyphPhysicsProfile, gameCoverProfile, collisionAudio, unlockGameAudio, playCollisionSound, handleGameContact, flushGameContacts, applyGroundImpact, animateCaptureEffects, animateGame, fitBattleCamera, leaveGame, localPoint }; </script>";
	const html = (await response.text()).replace("</script>", expose);
	await route.fulfill({ /* response：保留原回應；body：唯此測試可見的接點。 */ response, body: html });
}

async function pointerUiCheck(page) {
	await page.evaluate(async () => { document.getElementById("mode").value = "local"; await window.__game.startGame(); });
	await page.locator("#game-board").scrollIntoViewIfNeeded();
	const bounds = await page.locator("#game-board").boundingBox();
	assert.ok(bounds && bounds.height > 0, "拖曳必須在真實可見桌面進行");
	const viewport = page.viewportSize();
	assert.ok(Math.abs(bounds.width - bounds.height) < 2 && bounds.width <= viewport.width + 1 && bounds.height <= viewport.height * 0.8 + 2, "圓形場地的顯示區須為不超過80vh與視窗寬度的正方形");
	for (const id of ["game-angle", "coin-list"]) {
		const control = await page.locator(`#${id}`).boundingBox();
		assert.ok(control && (control.y + control.height <= bounds.y || control.y >= bounds.y + bounds.height), "角度與選枚控制必須置於戰場上方或下方");
	}
	const x = bounds.x + bounds.width / 2, bottom = bounds.y + bounds.height * 0.9, target = bounds.y + bounds.height * 0.55;
	const initialAim = await page.evaluate(() => window.__game.game.aim.toArray());
	await page.mouse.click(x + 50, target);
	await page.keyboard.press("Enter");
	assert.deepEqual(await page.evaluate(() => window.__game.game.aim.toArray()), initialAim, "非底部單點不可改變瞄準");
	assert.ok(await page.evaluate(() => window.__game.game.status === "ready" && window.__game.game.coins.every((coin) => !coin.body)), "單點與 Enter 都不能代替底部拖曳投擲");
	assert.equal(await page.locator("#throw-game").count(), 0, "介面不可保留投擲按鈕");
	await page.mouse.move(x, bottom);
	await page.mouse.down();
	await page.mouse.move(x, bottom - 5);
	await page.mouse.up();
	assert.equal(await page.evaluate(() => window.__game.game.status), "ready", "短拖曳必須取消投擲");
	assert.ok(await page.evaluate(() => window.__game.collisionAudio.context?.state === "running"), "真正外圍手勢必須解鎖瀏覽器音效");
	assert.equal(await page.evaluate(() => window.__game.game.coins.filter((coin) => coin.body).length), 0, "取消不能產生物理薄片");
	await page.mouse.move(x, bottom);
	await page.mouse.down();
	await page.mouse.move(x + 20, target);
	const preview = await page.evaluate(() => {
		const game = window.__game.game, arrow = document.getElementById("throw-arrow");
		return { /* active、visible：手勢與箭頭狀態；coordinates、landing：有限預測資料；angle：拖曳不能偷偷修改物理控制。 */ active: game.drag?.active, visible: !document.getElementById("throw-preview").hasAttribute("hidden"), coordinates: ["x1", "y1", "x2", "y2"].map((key) => Number(arrow.getAttribute(key))), landing: game.drag?.landing.toArray(), angle: game.angleDegrees };
	});
	assert.ok(preview.active && preview.visible && preview.coordinates.every(Number.isFinite) && preview.landing.every(Number.isFinite), "長拖曳必須顯示有限箭頭與預測落點");
	assert.equal(preview.angle, 35, "拖曳只能瞄準，不可暗中調整選定仰角");
	await page.mouse.up();
	const released = await page.evaluate(() => {
		const { game, config } = window.__game, body = game.coins.find((coin) => coin.id === game.thrownId)?.body;
		const height = body.position.y - config.thickness / 2 - 0.003;
		const time = (body.velocity.y + Math.sqrt(body.velocity.y ** 2 + 2 * config.gravity * height)) / config.gravity;
		return { /* status、hidden、active：放開後清理；predictionError：無碰撞拋物線終點與箭頭落點距離。 */ status: game.status, hidden: document.getElementById("throw-preview").hasAttribute("hidden"), active: !!game.drag, predictionError: Math.hypot(body.position.x + body.velocity.x * time - game.aim.x, body.position.z + body.velocity.z * time - game.aim.z) };
	});
	assert.ok(released.status === "simulating" && released.hidden && !released.active && released.predictionError < 1e-8, `放開應真正投擲，收起箭頭，並保留無碰撞預測落點：${JSON.stringify(released)}`);
	await page.evaluate(async () => { document.getElementById("mode").value = "cpu"; await window.__game.startGame(); window.__game.game.current = 1; });
	await page.mouse.move(x, bottom);
	await page.mouse.down();
	await page.mouse.move(x, target);
	await page.mouse.up();
	assert.ok(await page.evaluate(() => !window.__game.game.drag && window.__game.game.status === "ready" && window.__game.game.coins.every((coin) => !coin.body)), "電腦回合不可由玩家拖曳偷投");
	console.log("拖曳：短拖取消、箭頭與落點、放開投擲、CPU 回合鎖定通過");
}

async function flickSpeedCheck(page) {
	const launches = [];
	for (const delay of [0, 150]) {
		await page.evaluate(async () => { document.getElementById("mode").value = "local"; document.getElementById("game-angle").value = 35; await window.__game.startGame(); });
		await page.locator("#game-board").scrollIntoViewIfNeeded();
		const bounds = await page.locator("#game-board").boundingBox(), x = bounds.x + bounds.width / 2;
		await page.mouse.move(x, bounds.y + bounds.height * 0.9);
		await page.mouse.down();
		// 使用完全相同的六段路徑；僅改事件間隔，驗證速度而不是距離控制。
		for (let index = 1; index <= 6; index++) {
			await page.mouse.move(x, bounds.y + bounds.height * (0.9 - index * 0.4 / 6));
			if (delay) await page.waitForTimeout(delay);
		}
		await page.mouse.up();
		launches.push(await page.evaluate(() => {
			const { game } = window.__game, body = game.coins.find((coin) => coin.id === game.thrownId)?.body;
			return { /* gesture：真正手勢時間推算值；velocity：實際剛體速度；aim、angle、status：排除不同方向及未投出的假比較。 */ gesture: game.swipeSpeed, velocity: body?.velocity.length(), aim: game.aim.toArray(), angle: game.angleDegrees, status: game.status };
		}));
	}
	assert.ok(launches.every((launch) => launch.status === "simulating" && launch.angle === 35), "快慢手勢都必須真正投出且保留同一仰角");
	assert.ok(launches[0].gesture > launches[1].gesture * 2, "同路徑快拖與慢拖必須量到不同手勢速度");
	assert.ok(launches[0].velocity > launches[1].velocity * 1.25, "同路徑快拖必須產生更高實際初速度");
	for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(launches[0].aim[axis] - launches[1].aim[axis]) < 1e-8, "同路徑快慢拖曳仍須瞄準同一位置");
	const gain = (speed) => 0.8 + 0.4 * Math.max(0, Math.min(3, speed));
	assert.ok(Math.abs(launches[0].velocity / launches[1].velocity - gain(launches[0].gesture) / gain(launches[1].gesture)) < 1e-8, "真正初速度倍率必須由量到的手勢速度推導");
	console.log("同路徑快慢拖曳：手勢時間與真正發射速度連動通過");
}

async function perimeterDragCheck(page) {
	for (const [startX, startY] of [[0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5]]) {
		await page.evaluate(async () => { document.getElementById("mode").value = "local"; await window.__game.startGame(); });
		await page.locator("#game-board").scrollIntoViewIfNeeded();
		const bounds = await page.locator("#game-board").boundingBox(), x = bounds.x + bounds.width * startX, y = bounds.y + bounds.height * startY;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + (startX - 0.5) * 70, y + (startY - 0.5) * 70);
		await page.mouse.up();
		assert.equal(await page.evaluate(() => window.__game.game.status), "ready", "四邊向外甩動均不可投出");
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
		const drag = await page.evaluate(() => { const { game } = window.__game; return { /* start：手勢世界起點；aim：真正瞄準；active：須由外圍開始。 */ start: game.drag?.startWorld?.toArray(), aim: game.aim.toArray(), active: game.drag?.active }; });
		assert.ok(drag.active && drag.start?.every(Number.isFinite), "四邊外圍起拖都必須建立真正世界起點");
		await page.mouse.up();
		const launch = await page.evaluate(() => { const { game } = window.__game; return { /* status：真正投擲；velocity：檢查水平發射方向，不只看箭頭。 */ status: game.status, velocity: game.coins.find((coin) => coin.id === game.thrownId)?.body?.velocity.toArray() }; });
		assert.equal(launch.status, "simulating", "上、右、下、左四個方向向內甩都須真正投出");
		const dx = drag.aim[0] - drag.start[0], dz = drag.aim[2] - drag.start[2], distance = Math.hypot(dx, dz), speed = Math.hypot(launch.velocity[0], launch.velocity[2]);
		assert.ok(distance > 0 && speed > 0 && Math.abs(dx / distance - launch.velocity[0] / speed) < 1e-8 && Math.abs(dz / distance - launch.velocity[2] / speed) < 1e-8, `真實水平初速度必須對齊手勢世界起點到瞄準點方向：${JSON.stringify({ startX, startY, drag, launch })}`);
	}
	await page.evaluate(async () => { document.getElementById("mode").value = "local"; await window.__game.startGame(); });
	const bounds = await page.locator("#game-board").boundingBox();
	await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.6);
	await page.mouse.up();
	assert.ok(await page.evaluate(() => window.__game.game.status === "ready" && !window.__game.game.drag), "中央區域起拖不得投擲");
	console.log("四邊甩動：向外取消、向內投擲、真實速度方向及中央禁投通過");
}

async function cameraResizeCheck(page) {
	const originalViewport = page.viewportSize();
	try {
		await page.evaluate(async () => { document.getElementById("mode").value = "local"; await window.__game.startGame(); });
		const snapshots = [];
		for (const viewport of [{ width: 1280, height: 720 }, { width: 760, height: 900 }]) {
			await page.setViewportSize(viewport);
			snapshots.push(await page.evaluate(() => {
				const { state, game, fitBattleCamera } = window.__game;
				fitBattleCamera();
				state.camera.updateMatrixWorld(true);
				const board = document.getElementById("game-board");
				return { /* pose、projection：真相機矩陣；direction：保持15度；aspect、right、top：投影只由視窗長寬比推導。 */ pose: state.camera.matrixWorld.toArray(), projection: state.camera.projectionMatrix.toArray(), direction: state.camera.getWorldDirection(game.aim.clone()).toArray(), aspect: board.clientWidth / board.clientHeight, right: state.camera.right, top: state.camera.top };
			}));
		}
		assert.deepEqual(snapshots[0].pose, snapshots[1].pose, "調整視窗只可改投影，不可移動場景座標原點或鏡頭姿態");
		for (const snapshot of snapshots) {
			assert.ok(Math.abs(snapshot.aspect - 1) < 0.01 && Math.abs(snapshot.top - 10.2) < 1e-8 && Math.abs(snapshot.right - snapshot.top * snapshot.aspect) < 1e-8, `正方形顯示區resize後仍須保持固定10.2m正交半幅：${JSON.stringify(snapshot)}`);
			assert.ok(Math.abs(snapshot.direction[1] + Math.cos(Math.PI / 12)) < 1e-8 && Math.abs(snapshot.direction[2] + Math.sin(Math.PI / 12)) < 1e-8, "resize 後仍須維持15度傾角");
		}
		console.log("固定鏡頭：正方形resize維持固定幅面、原點與15度姿態");
	}
	finally { await page.setViewportSize(originalViewport); }
}

async function runChecks() {

	const api = window.__game;
	const passed = [], failures = [], measurements = [];
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

	function shapeWorldVertices(body, index) {
		const shape = body.shapes[index], extent = shape.halfExtents;
		const vertices = shape.vertices ? shape.vertices.map((vertex) => vertex.clone()) : [];
		if (extent) {
			for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) vertices.push(body.position.clone().set(x * extent.x, y * extent.y, z * extent.z));
		}
		requireCondition(vertices.length === 8, "每個碰撞分片必須是八角點的實心薄片");
		return vertices.map((vertex) => body.quaternion.vmult(body.shapeOrientations[index].vmult(vertex).vadd(body.shapeOffsets[index])));
	}

	function assertBodyMask(body, model) {
		// 從真正引擎方盒／翹曲凸片的世界角點反推網格，仍逐格拒絕填洞、重疊與漏格。
		const rectangles = [];
		for (let index = 0; index < body.shapes.length; index++) {
			const vertices = shapeWorldVertices(body, index), pairs = new Map();
			for (const vertex of vertices) {
				const key = `${vertex.x.toFixed(8)},${vertex.z.toFixed(8)}`;
				if (!pairs.has(key)) pairs.set(key, []);
				pairs.get(key).push(vertex.y);
			}
			requireCondition(pairs.size === 4, "碰撞分片水平投影必須保持原矩形格區");
			for (const heights of pairs.values()) {
				requireCondition(heights.length === 2, "每個水平角點必須具上下表面");
				near(Math.abs(heights[1] - heights[0]), api.config.thickness, "翹曲不得改變垂直材料厚度");
			}
			const minimumX = Math.min(...vertices.map((vertex) => vertex.x)), minimumZ = Math.min(...vertices.map((vertex) => vertex.z));
			const width = (Math.max(...vertices.map((vertex) => vertex.x)) - minimumX) / model.step, height = (Math.max(...vertices.map((vertex) => vertex.z)) - minimumZ) / model.step;
			rectangles.push({ /* row、col：世界角點还原的起始格；width、height：真正凸片水平投影的佔據格數。 */ row: (minimumZ + model.cz + api.config.size / 2) / model.step, col: (minimumX + model.cx + api.config.size / 2) / model.step, width, height });
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
		// 一般規則固定非爆炸；機率案例自行覆寫並由 finally 恢復全域隨機函式。
		const originalRandom = Math.random;
		Math.random = () => 0.9;
		try {
			await action();
			passed.push(label);
		}
		catch (error) {
			failures.push(`${label}: ${error.message}`);
		}
		finally { Math.random = originalRandom; }
	}

	async function newGame(mode = "local") {
		// 從真正設定流程建立六枚，避免由測試自行製造初始所有權。
		document.getElementById("mode").value = mode;
		document.getElementById("game-angle").value = 35;
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

	function captureEffects() {
		return api.game.effects.filter((effect) => effect.type === "capture");
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
		body.updateAABB();
		body.position.y += 0.003 - body.aabb.lowerBound.y;
		body.aabbNeedsUpdate = true;
		body.wakeUp();
		return body;
	}

	function backface(coin) {
		coin.body.quaternion.setFromEuler(Math.PI, -coin.model.angle, 0);
		coin.body.updateInertiaWorld(true);
		coin.body.aabbNeedsUpdate = true;
		coin.body.updateAABB();
		coin.body.position.y += 0.003 - coin.body.aabb.lowerBound.y;
		coin.body.aabbNeedsUpdate = true;
		coin.supportSnapshot = null;
		coin.body.wakeUp();
	}

	function step(ticks = 360) {
		for (let tick = 0; tick < ticks; tick++) api.state.world.step(1 / 120);
	}

	function settleGameBodies() {
		// 純物理fixture最多35秒真步進；仍逐枚要求原速度與真支撐條件，與真時間回合逾時分開驗。
		for (let tick = 0; tick < 4200; tick++) {
			step(1);
			if (api.game.coins.every((coin) => !coin.body || api.isGameCoinResting(coin))) return;
		}
		throw new Error(`35秒後仍未真停止：${JSON.stringify(api.game.coins.filter((coin) => coin.body && !api.isGameCoinResting(coin)).map((coin) => ({ id: coin.id, y: coin.body.position.y, v: coin.body.velocity.length(), w: coin.body.angularVelocity.length() })))}`);
	}

	function beginThrow() {
		const player = api.game.current;
		const candidate = owned(player).find((coin) => coin.body === null) || owned(player)[0];
		requireCondition(api.selectGameCoin(candidate.id), "合法枚應可選取");
		api.game.angleDegrees = 35;
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
		api.game.angleDegrees = 35;
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
		step();
		const thrown = beginThrow();
		requireCondition(enemy.faceBeforeThrow === 1, "必須由真實穩定正面取得本次出手前基準");
		backface(enemy);
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
		settleGameBodies();
		requireCondition(api.isGameCoinResting(enemy), "捕獲前必須有真實穩定支撐");
		requireCondition(captureEffects().length === 0, "只有碰撞或翻面尚未結算時不可提前播捕獲特效");
		const previousBody = enemy.body;
		api.finishGameTurn();
		requireCondition(enemy.owner === 0 && enemy.body === null, "命中後相對基準翻為背面並停止的敵枚應進攻方手中");
		requireCondition(enemy.id === enemyId && enemy.text === enemyText && enemy.font === enemyFont && enemy.model === enemyModel, "捕獲必須保留身份、字體及完整物理模型");
		requireCondition(!api.state.world.bodies.includes(previousBody), "捕獲後桌面舊剛體必須移除");
		requireCondition(api.game.current === 1 && api.game.status === "ready", "捕獲判給出手者後才交替回合");
		requireCondition(captureEffects().length === 1, "真正停止並捕獲後才產生一次捕獲特效");
		const capturedState = JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.body?.id]));
		api.animateCaptureEffects(0.2);
		requireCondition(captureEffects().length === 1 && captureEffects()[0].elapsed > 0, "捕獲特效必須有真正的可更新生命週期");
		api.animateCaptureEffects(1);
		requireCondition(api.game.effects.length === 0, "特效結束須清理視覺物件");
		requireCondition(JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.body?.id])) === capturedState, "特效更新或清理不能修改捕獲結果或物理薄片");
		assertSix();

		// 下一輪再投出剛捕獲的同枚，確認保留模型不只停留在資料欄位。
		beginThrow();
		api.finishGameTurn(true);
		api.game.aim.set(-3, 0, 2);
		api.game.angleDegrees = 35;
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
		step();
		const thrown = beginThrow();
		backface(enemies[0]);
		backface(enemies[2]);
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
		requireCondition(captureEffects().length === 0, "未成立的捕獲不能產生成功特效");
		requireCondition(thrown.owner === 0 && thrown.body, "自投枚即使背面也不可因己方動作入手");
		assertSix();

		await newGame();
		const airborne = owned(1)[0], standing = owned(1)[1], airSupport = owned(1)[2];
		place(airborne, -4);
		place(standing, 4);
		place(airSupport, -4, -3);
		step();
		const projectile = beginThrow();
		backface(airborne);
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

	async function relativeFaceCheck() {
		for (const [before, after] of [[1, -1], [-1, 1], [1, 1], [-1, -1]]) {
			await newGame();
			const enemy = owned(1)[0], model = enemy.model;
			place(enemy, -3);
			if (before === -1) backface(enemy);
			step();
			requireCondition(api.isGameCoinResting(enemy), "相對翻面基準必須先有真實接地及停止");
			const thrown = beginThrow();
			requireCondition(enemy.faceBeforeThrow === before, "出手時必須保存真正穩定朝上面，不能一律當作正面");
			place(thrown, 3, 3);
			place(enemy, -3);
			if (after === -1) backface(enemy);
			if (before === after) {
				// 同一面只在桌面內旋轉字樣方向，不得被誤認為翻到另一面。
				enemy.body.quaternion.setFromEuler(after === -1 ? Math.PI : 0, -model.angle + Math.PI, 0);
				enemy.body.updateInertiaWorld(true);
				enemy.body.aabbNeedsUpdate = true;
			}
			enemy.hit = true;
			settleGameBodies();
			requireCondition(api.isGameCoinResting(enemy), "相對翻面結果仍必須取得真實支撐並停止");
			requireCondition(captureEffects().length === 0, "相對翻面尚未结算時不得提前播成功特效");
			api.finishGameTurn();
			const flipped = before !== after;
			requireCondition(enemy.owner === (flipped ? 0 : 1) && (enemy.body === null) === flipped, "只有最終相對出手前變成另一面才捕獲；正轉背與背轉正皆成立");
			requireCondition(captureEffects().length === (flipped ? 1 : 0), "特效必須與相對翻面捕獲結果一致");
			requireCondition(enemy.model === model, "正背兩方向捕獲均不能改原字形物性");
			assertSix();
		}
	}

	async function missingFaceBaselineCheck() {
		for (const initial of ["airborne", "moving", "standing"]) {
			await newGame();
			const enemy = owned(1)[0];
			place(enemy, -3);
			step();
			enemy.body.wakeUp();
			enemy.supportSnapshot = null;
			if (initial === "airborne") { enemy.body.position.y = 5; enemy.body.aabbNeedsUpdate = true; step(1); }
			if (initial === "moving") enemy.body.velocity.x = 0.5;
			if (initial === "standing") {
				enemy.body.quaternion.setFromEuler(Math.PI / 2, 0, 0);
				enemy.body.updateAABB();
				enemy.body.position.y += -0.001 - enemy.body.aabb.lowerBound.y;
				enemy.body.aabbNeedsUpdate = true;
				step(1);
				enemy.body.velocity.set(0, 0, 0);
				enemy.body.angularVelocity.set(0, 0, 0);
				requireCondition(api.isGameCoinResting(enemy), "初始側立 fixture 必須有真實地面支撐，不能用空中原因掩蓋");
			}
			enemy.body.aabbNeedsUpdate = true;
			const thrown = beginThrow();
			requireCondition(enemy.faceBeforeThrow === 0, "空中、移動或側立不能取得可靠出手前面向");
			place(thrown, 3, 3);
			place(enemy, -3);
			backface(enemy);
			enemy.hit = true;
			settleGameBodies();
			requireCondition(api.isGameCoinResting(enemy), "缺基準案例的最終背面必須确實停止並接地");
			api.finishGameTurn(true);
			requireCondition(enemy.owner === 1 && enemy.body && captureEffects().length === 0, "缺少可靠初始面向時，即使後來命中且背面停止也不能捕獲或播成功特效");
			assertSix();
		}
	}

	async function multiAndWinCheck() {
		await newGame();
		const enemies = owned(1);
		for (let index = 0; index < enemies.length; index++) {
			place(enemies[index], -4 + index * 4, -3);
		}
		step();
		const thrown = beginThrow();
		for (const coin of enemies) backface(coin);
		place(thrown, 0, 3);
		settleGameBodies();
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
		}
		step();
		const finalThrow = beginThrow();
		for (const coin of finalEnemies) backface(coin);
		place(finalThrow, 0, 3);
		settleGameBodies();
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
		requireCondition(Number.isFinite(plan.angleDegrees) && plan.angleDegrees >= 15 && plan.angleDegrees <= 65, "電腦角度必須合法");
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
		for (const [angle, swipeSpeed] of [[15, 0], [35, 0.5], [65, 3]]) {
			await newGame();
			const coin = owned(0)[0], model = coin.model;
			requireCondition(api.selectGameCoin(coin.id), "能量驗收必須由合法選枚進入");
			api.game.angleDegrees = angle;
			api.game.swipeSpeed = swipeSpeed;
			api.game.aim.set(0, 0, 0);
			requireCondition(api.throwGameCoin(), "能量驗收必須建立實際投擲剛體");
			const body = coin.body;
			const omega = body.quaternion.conjugate().vmult(body.angularVelocity);
			const kinetic = 0.5 * body.mass * body.velocity.lengthSquared();
			const rotation = 0.5 * (model.inertia.x * omega.x ** 2 + model.inertia.y * omega.y ** 2 + model.inertia.z * omega.z ** 2);
			const potential = body.mass * api.config.gravity * (body.position.y - floorHeight);
			const coverage = model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
			const budget = 1.05 * 0.3 * api.config.gravity + 4 * (0.75 - 0.5 * coverage);
			const remaining = budget - potential, baseLinear = Math.min(0.75 * remaining, 18 * model.mass, 0.72 / model.mass), gain = 0.8 + 0.4 * swipeSpeed;
			near(kinetic, baseLinear * gain ** 2, "真正平移動能必須隨手勢速度倍率平方增加");
			near(rotation, 0.09 * (remaining - baseLinear), "初始旋轉能量降為原來9%，未用能量不能補入平移");
			near(kinetic + rotation + potential, potential + baseLinear * gain ** 2 + 0.09 * (remaining - baseLinear), "手勢平移、降低後旋轉與高度必須按新實際能量記帳");
			near(body.position.y - floorHeight, 0.9 + 0.2 * (0.75 - 0.5 * coverage), "出生高度只由字形決定");
			near(Math.atan2(body.velocity.y, Math.hypot(body.velocity.x, body.velocity.z)) * 180 / Math.PI, angle, "真正發射仰角必須符合唯一物理控制");
			requireCondition(body.velocity.length() <= 6 * gain + 1e-9 && body.mass * body.velocity.length() <= 1.2 * gain + 1e-9 && body.velocity.length() <= 12 + 1e-9, "手勢放大後仍須遵守相應速度及動量上限");
			requireCondition(kinetic >= 0 && rotation >= 0 && potential >= -1e-9, "不可用負能量掩蓋超額發射");
		}
	}

	function sampleRawRectangle(columns, rows, alpha = 255) {
		// 以解析矩形 alpha 取樣建立原始材料模型，覆蓋率由 fixture 尺寸決定。
		const original = CanvasRenderingContext2D.prototype.getImageData;
		function knownImage(x, y, width, height) {
			const image = original.call(this, x, y, width, height);
			image.data.fill(0);
			for (let row = 0; row < height * rows / 16; row++) {
				for (let col = 0; col < width * columns / 16; col++) image.data[(row * width + col) * 4 + 3] = alpha;
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
		for (const swipeSpeed of [0, 0.5, 3]) {
			let previousMass = 0, previousEnergy = Infinity, previousDamping = 0;
			for (const side of [1, 4, 8, 12, 16]) {
				await newGame();
				api.game.swipeSpeed = swipeSpeed;
				const gain = 0.8 + 0.4 * swipeSpeed;
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
				api.game.angleDegrees = 35;
				requireCondition(api.throwGameCoin(), "規範化字形必須可以真正投擲");
				const body = coin.body, omega = body.quaternion.conjugate().vmult(body.angularVelocity);
				const rotation = 0.5 * (balanced.inertia.x * omega.x ** 2 + balanced.inertia.y * omega.y ** 2 + balanced.inertia.z * omega.z ** 2);
				const energy = 0.5 * body.mass * body.velocity.lengthSquared() + rotation + body.mass * api.config.gravity * (body.position.y - floorHeight);
				const potential = mass * api.config.gravity * (0.9 + 0.2 * (0.75 - 0.5 * coverage)), remaining = 1.05 * 0.3 * api.config.gravity + 3 - 2 * coverage - potential;
				near(energy, potential + (0.75 * gain ** 2 + 0.0225) * remaining, "慢、中、快手勢均須扣除未使用旋轉能量並保持密度能量單調");
				near(body.mass, mass, "規範化質量必須直接作用於剛體");
				near(body.angularDamping, 0.08 + 0.24 * (0.25 + 0.5 * coverage), "高覆蓋率防守耗散必須直接作用於剛體");
				requireCondition(body.mass > previousMass && energy < previousEnergy && body.angularDamping > previousDamping, "密度上升必須提高質量與耗散、嚴格降低实际發射能量");
				requireCondition(body.velocity.length() <= 6 * gain + 1e-9 && body.mass * body.velocity.length() <= 1.2 * gain + 1e-9, "低密度亦不得突破速度與衝量上限");
				assertBodyMask(body, balanced);
				requireCondition(JSON.stringify(raw) === original, "建立及投擲遊戲剛體仍不得污染原材料模型");
				previousMass = body.mass;
				previousEnergy = energy;
				previousDamping = body.angularDamping;
			}
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
			api.game.angleDegrees = 35;
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
			const velocityBefore = body.velocity.clone(), positionBefore = body.position.clone(), orientationBefore = body.quaternion.clone(), spinBefore = body.angularVelocity.clone();
			const localUp = body.quaternion.conjugate().vmult(body.position.clone().set(0, 1, 0)), torque = point.cross(localUp);
			const localSpin = body.quaternion.conjugate().vmult(spinBefore);
			const b = body.velocity.y + localSpin.dot(torque), k = 1 / body.mass + torque.x ** 2 / body.inertia.x + torque.y ** 2 / body.inertia.y + torque.z ** 2 / body.inertia.z;
			const oldEnergy = 1.2 * (0.75 - 0.5 * side * side / 256) / 0.75;
			const oldImpulse = Math.min(0.8, (-b + Math.sqrt(b * b + 2 * k * oldEnergy)) / k);
			api.handleGameContact(body, event);
			const after = kineticEnergy(body), extra = after - before;
			const coverage = side * side / 256;
			near(extra, b * 2 * oldImpulse + 0.5 * k * (2 * oldImpulse) ** 2, "雙倍邊緣衝量必須依完整線／角動能計帳");
			const impulse = body.mass * (body.velocity.y - velocityBefore.y);
			near(impulse, 2 * oldImpulse, "實際邊緣壓力衝量必須為原來兩倍");
			const deltaSpin = body.quaternion.conjugate().vmult(body.angularVelocity.vsub(spinBefore));
			for (const axis of ["x", "y", "z"]) near(deltaSpin[axis], 2 * oldImpulse * torque[axis] / body.inertia[axis], "角速增量必須符合雙倍偏心衝量");
			requireCondition(impulse <= 1.6 + 1e-9, "雙倍助推仍受1.6Ns上限限制");
			near(body.position.distanceTo(positionBefore), 0, "助推不可直接改變位置");
			for (const axis of ["x", "y", "z", "w"]) near(body.quaternion[axis], orientationBefore[axis], "助推不可強制指定姿態或正背面");
			requireCondition(extra < previousExtra && enemy.assistUsed && enemy.hit, "較密攻方必須取得較低加成上限，並標記本枚已使用");
			api.handleGameContact(body, event);
			near(kineticEnergy(body), after, "同枚敵方在同次投擲不得重複取得助推");
			requireCondition(enemy.owner === 1, "邊緣助推不能直接代替最終判面或捕獲");
			previousExtra = extra;
		}

		await newGame();
		const attacker = beginThrow(), enemy = owned(1)[0], body = place(enemy, 3);
		const point = api.localPoint(enemy.model.cells[0], enemy.model), offset = body.quaternion.vmult(point);
		let impact = 0.19;
		const event = { /* body：真正攻方；contact：隔離新入射門檻的同一邊緣與可控入射速度。 */ body: attacker.body, contact: { /* bi、ri：真實敵枚及世界力臂；getImpactVelocityAlongNormal：僅改門檻條件，不指定結果。 */ bi: body, ri: offset, getImpactVelocityAlongNormal: () => impact } };
		api.handleGameContact(body, event);
		requireCondition(!enemy.assistUsed && body.velocity.length() === 0, "低於0.2m/s時仍不可無條件取得邊緣助推");
		impact = 0.3;
		api.handleGameContact(body, event);
		requireCondition(enemy.assistUsed && body.velocity.y > 0 && body.angularVelocity.length() > 0, "介於新舊門檻的0.3m/s邊緣按壓應產生真正向上及旋轉反應");
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
			const torque = point.cross(impulse.clone().set(0, 1, 0)), b = this.velocity.y - impulse.y / this.mass + spin.dot(torque);
			impulses.push({ /* energy、spin：實際動能及角速增量；correction：雙倍衝量能量修正；edge：純向上邊緣施力，與向外震波分開計數。 */ energy: kineticEnergy(this) - before, spin: this.angularVelocity.distanceTo(spin), correction: 2 * Math.max(0, -b) * impulse.y / 2, edge: Math.hypot(impulse.x, impulse.z) < 1e-10 });
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
		requireCondition(impulses[0].energy <= 4 * 1.2 * (0.75 - 0.5 * coverage) / 0.75 + impulses[0].correction + 1e-8, "真實求解後雙倍衝量須遵守含交叉項的能量上界");
		requireCondition(api.game.contacts.length === 0 && enemy.owner === 1, "本步接觸佇列應清空且不能直接捕獲");
		step(90);
		requireCondition(impulses.filter((impulse) => impulse.edge).length === 1, "後續真實碰撞不可重複施加邊緣助推同一敵枚；向外落地震波另有獨立單次驗收");

		// 保留真正產生的接觸，重現重開發生於待處理接觸存在時的生命週期。
		api.game.contacts.push(savedContact);
		await newGame();
		requireCondition(api.game.contacts.length === 0, "重開必須丟棄舊局待處理接觸");
		api.game.contacts.push(savedContact);
		api.flushGameContacts();
		requireCondition(api.game.contacts.length === 0 && api.game.coins.every((coin) => !coin.body && !coin.hit && !coin.assistUsed), "過期接觸到達不可改變新局或遺留佇列");
		assertSix();
	}

	async function groundImpactLifecycleCheck() {
		await newGame();
		const source = beginThrow(), body = place(source);
		body.position.y = 0.25;
		body.velocity.set(0, -4, 0);
		body.aabbNeedsUpdate = true;
		let contacts = 0, firstPoint = null;
		body.addEventListener("collide", (event) => {
			if (event.body !== api.state.floor) return;

			contacts++;
			if (contacts !== 1) return;

			requireCondition(!api.game.groundImpactUsed && api.game.effects.every((effect) => effect.type !== "shock"), "真正落地 collide 內不可提前施加或呈現震波");
			const contact = event.contact, offset = contact.bi === body ? contact.ri : contact.rj;
			firstPoint = body.position.vadd(offset);
		});
		for (let tick = 0; tick < 60 && !api.game.groundImpactUsed; tick++) step(1);
		requireCondition(contacts > 0 && api.game.groundImpactUsed && api.game.lastGroundImpact?.sourceId === source.id, "真正投出枚首次接地後必須產生一次震波");
		const record = api.game.lastGroundImpact, shock = api.game.effects.filter((effect) => effect.type === "shock");
		requireCondition(shock.length === 1 && captureEffects().length === 0, "落地只產生震波，不能冒充捕獲成功");
		near(record.origin.x, firstPoint.x, "震源須保存真實求解前接觸橫座標");
		near(record.origin.z, firstPoint.z, "震源須保存真實求解前接觸縱座標");
		near(shock[0].duration, 0.6, "震波視覺具有獨立短生命週期");
		const firstCalls = api.game.effects.length;
		requireCondition(!api.applyGroundImpact({ body, other: api.state.floor, groundPoint: firstPoint, impact: 4 }) && api.game.effects.length === firstCalls, "同一連續接地的多像素回呼不可疊加震波或重抽");
		// 真離地需經world.step確認無地面接觸，再次落地才允許重新抽選。
		place(source);
		body.position.y = 0.5;
		body.velocity.set(0, -2, 0);
		body.aabbNeedsUpdate = true;
		step(1);
		requireCondition(!api.game.groundImpactUsed && !api.state.world.contacts.some((contact) => (contact.bi === body && contact.bj === api.state.floor) || (contact.bj === body && contact.bi === api.state.floor)), "真正離地後須重新開放落地衝擊");
		Math.random = () => 0.1;
		for (let tick = 0; tick < 120 && api.game.lastGroundImpact === record; tick++) step(1);
		requireCondition(contacts > 1 && api.game.lastGroundImpact !== record && api.game.lastGroundImpact.explosive && api.game.effects.filter((effect) => effect.type === "explosion").length === 1, "第二次真落地須重新抽選並可產生爆炸，不沿用首次普通結果");
		const before = JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.body?.id]));
		api.animateCaptureEffects(0.2);
		requireCondition(shock[0].elapsed > 0 && shock[0].ring.scale.x > 0, "震波必須真正更新視覺生命週期");
		api.animateCaptureEffects(1);
		requireCondition(api.game.effects.length === 0 && !api.state.scene.children.includes(shock[0].group), "震波到期須移除場景物件");
		requireCondition(JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.body?.id])) === before, "震波視覺清理不可修改物理物件或所有權");
		api.finishGameTurn(true);
		beginThrow();
		requireCondition(!api.game.groundImpactUsed && api.game.lastGroundImpact == null, "下一手合法投擲應重新開放落地震波");
		await newGame();
		requireCondition(!api.game.groundImpactUsed && api.game.lastGroundImpact == null && api.game.effects.length === 0, "重開應清理落地旗標、紀錄與特效");
		assertSix();
	}

	async function groundImpactBudgetCheck() {
		// 隔離震波施力函式；觸發來源真接地與求解時序由上一案例另行驗證。
		for (const moving of [false, true]) {
			await newGame();
			const friendly = owned(0)[1], hand = owned(0)[2], [nearEnemy, farEnemy, outside] = owned(1);
			const model = api.balanceGameModel(sampleRawRectangle(1, 1));
			for (const coin of [friendly, nearEnemy, farEnemy, outside]) coin.model = model;
			place(friendly, -0.7);
			place(nearEnemy, 0.7);
			place(farEnemy, 1.8);
			place(outside, 4);
			step();
			const source = beginThrow(), origin = source.body.position.clone().set(0, 0.03, 0), impact = 5;
			const offense = 0.75 - 0.5 * source.model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
			const radius = 2.2 + 0.8 * offense, budget = Math.min(2.4, 0.12 * source.model.mass * impact ** 2 * offense);
			if (moving) { outside.body.position.set(0, radius + 1, 0); outside.body.aabbNeedsUpdate = true; }
			const snapshots = new Map();
			for (const coin of [friendly, nearEnemy, farEnemy, outside]) {
				const body = coin.body;
				body.wakeUp();
				body.velocity.set(moving ? 0.4 : 0, moving ? -2 : 0, 0);
				body.angularVelocity.set(moving ? 3 : 0, 0, moving ? -4 : 0);
				body.updateInertiaWorld(true);
				snapshots.set(coin.id, { /* energy：量測前真動能；velocity：計算衝量；position、quaternion、owner：禁止施力直接改判定。 */ energy: kineticEnergy(body), velocity: body.velocity.clone(), position: body.position.clone(), quaternion: body.quaternion.clone(), owner: coin.owner });
			}
			const entry = { /* body、other、groundPoint、impact：隔離施力的已接地輸入，不能用來替代真碰撞案例。 */ body: source.body, other: api.state.floor, groundPoint: origin.clone(), impact };
			requireCondition(api.applyGroundImpact(entry), "合法震波輸入應真正施力");
			const affected = [friendly, nearEnemy, farEnemy], weights = affected.map((coin) => (1 - coin.body.position.distanceTo(origin) / radius) ** 2), totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
			let totalDelta = 0;
			for (let index = 0; index < affected.length; index++) {
				const coin = affected[index], body = coin.body, before = snapshots.get(coin.id);
				const delta = kineticEnergy(body) - before.energy, impulse = body.velocity.distanceTo(before.velocity) * body.mass;
				requireCondition(coin.hit && impulse > 0 && impulse <= 0.65 + 1e-8, "範圍內己方與敵方都須獲得有界真實衝量");
				requireCondition(delta <= budget * weights[index] / totalWeight + 1e-8, "每枚真實動能增量須包含既有角速交叉項並遵守權重分配");
				near(body.position.distanceTo(before.position), 0, "震波不能直接傳送薄片");
				for (const axis of ["x", "y", "z", "w"]) near(body.quaternion[axis], before.quaternion[axis], "震波不能強制旋轉到捕獲面");
				requireCondition(coin.owner === before.owner, "震波施力不能直接改所有權");
				totalDelta += delta;
			}
			requireCondition(totalDelta <= budget + 1e-8, "多枚震波的完整動能增量總和不得超過共享預算");
			if (!moving) requireCondition(nearEnemy.body.velocity.length() > farEnemy.body.velocity.length(), "同質量近處枚必須比遠處枚得到更強推動");
			near(outside.body.velocity.distanceTo(snapshots.get(outside.id).velocity), 0, "水平或垂直超出三維範圍的枚不可受波");
			requireCondition(!outside.hit && !hand.body && !hand.hit && hand.owner === 0, "範圍外及手中枚不可被標記受波或改所有權");
			const after = affected.map((coin) => kineticEnergy(coin.body));
				requireCondition(!api.applyGroundImpact(entry), "同一連續接地的震波核心須拒絕重複施力");
			for (let index = 0; index < affected.length; index++) near(kineticEnergy(affected[index].body), after[index], "重複震波不可累加能量");
			// 己方受波且最後翻到反面，仍必須免於自己的捕獲判定。
			place(source, 10);
			place(friendly, -10);
			backface(friendly);
			step(480);
			requireCondition(api.isGameCoinResting(friendly) && friendly.faceBeforeThrow === 1, "己方免疫 fixture 必須先有正面基準且真正背面停妥");
			api.finishGameTurn(true);
			requireCondition(friendly.owner === 0 && friendly.body, "己方即使被震波推動並翻面也不能被自己捕獲");
			assertSix();
		}
	}

	async function explosionBranchCheck() {
		const originalRandom = Math.random;
		try {
			for (const roll of [0.25, 0.249]) {
				for (const moving of [false, true]) {
					await newGame();
					const friendly = owned(0)[1], hand = owned(0)[2], [nearEnemy, extended, outside] = owned(1);
					const model = api.balanceGameModel(sampleRawRectangle(2, 2));
					for (const coin of [friendly, nearEnemy, extended, outside]) coin.model = model;
					place(friendly, -1);
					place(nearEnemy, 1);
					place(extended, 4);
					place(outside, 9);
					step();
					const source = beginThrow(), impact = 8, origin = source.body.position.clone().set(0, 0.03, 0);
					const offense = 0.75 - 0.5 * source.model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
					const explosive = roll < 0.25, radius = (2.2 + 0.8 * offense) * (explosive ? 2.5 : 1);
					const budget = Math.min(explosive ? 16 : 2.4, (explosive ? 0.9 : 0.12) * source.model.mass * impact ** 2 * offense);
					const snapshots = new Map(), targets = [friendly, nearEnemy, extended, outside];
					for (const coin of targets) {
						const body = coin.body;
						body.wakeUp();
						body.velocity.set(moving ? -0.8 : 0, moving ? -3 : 0, moving ? 1 : 0);
						body.angularVelocity.set(moving ? 2 : 0, moving ? -1 : 0, moving ? 4 : 0);
						snapshots.set(coin.id, { /* energy、velocity：量測真施力與交叉項；position、quaternion、owner：爆炸只能施力，不能替規則判結果。 */ energy: kineticEnergy(body), velocity: body.velocity.clone(), position: body.position.clone(), quaternion: body.quaternion.clone(), owner: coin.owner });
					}
					let draws = 0;
					Math.random = () => { draws++; return roll; };
					const entry = { /* body、other、impact、groundPoint：施力隔離輸入；真 floor 觸發另由生命週期案例驗證。 */ body: source.body, other: api.state.floor, impact, groundPoint: origin };
					requireCondition(!api.applyGroundImpact({ ...entry, impact: 0.19 }) && draws === 0, "未達合法落地門檻不可先抽爆炸機率");
					requireCondition(api.applyGroundImpact(entry), "合法首次落地必須抽選普通或爆炸分支");
					const record = api.game.lastGroundImpact, effect = api.game.effects.find((item) => item.type === (explosive ? "explosion" : "shock"));
					requireCondition(record.explosive === explosive && effect && captureEffects().length === 0, "25% 門檻兩側須進入對應分支，不得冒充捕獲成功");
					near(record.radius, radius, "爆炸作用半徑必須為普通半徑的2.5倍");
					near(effect.duration, explosive ? 0.9 : 0.6, "普通及爆炸效果須具各自生命週期");
					if (explosive) requireCondition(effect.sparks.length > 0, "爆炸須有獨立碎光視覺");
					const affected = targets.filter((coin) => snapshots.get(coin.id).position.distanceTo(origin) < radius);
					const weight = (coin) => (1 - snapshots.get(coin.id).position.distanceTo(origin) / radius) ** 2;
					const totalWeight = affected.reduce((sum, coin) => sum + weight(coin), 0);
					let deltaTotal = 0;
					for (const coin of targets) {
						const body = coin.body, before = snapshots.get(coin.id), delta = kineticEnergy(body) - before.energy;
						const impulse = body.mass * body.velocity.distanceTo(before.velocity);
						if (affected.includes(coin)) {
							requireCondition(coin.hit && impulse > 0 && impulse <= (explosive ? 2.4 : 0.65) + 1e-8, "普通及爆炸真衝量須遵守各分支上限");
							requireCondition(delta <= budget * weight(coin) / totalWeight + 1e-8, "爆炸分配預算亦須涵蓋既有平移及角速的完整動能");
							deltaTotal += delta;
						}
						else requireCondition(!coin.hit && impulse < 1e-10, "各分支範圍外不可受力或標記命中");
						near(body.position.distanceTo(before.position), 0, "爆炸不能直接改位置");
						for (const axis of ["x", "y", "z", "w"]) near(body.quaternion[axis], before.quaternion[axis], "爆炸不能強迫翻面");
						requireCondition(coin.owner === before.owner, "爆炸施力不能直接改所有權");
					}
					requireCondition(deltaTotal <= budget + 1e-8 && extended.hit === explosive, "爆炸須推動普通圈外的枚，且多枚總動能增量不超共享上限");
					if (!moving) measurements.push({ /* branch：固定機率分支；nearDistance：近端距離；deltaSpeed、deltaUp、angularSpeed：施力後真實速度，不冒充後續最高點。 */ branch: explosive ? "explosion" : "ordinary", nearDistance: 1, deltaSpeed: nearEnemy.body.velocity.distanceTo(snapshots.get(nearEnemy.id).velocity), deltaUp: nearEnemy.body.velocity.y - snapshots.get(nearEnemy.id).velocity.y, angularSpeed: nearEnemy.body.angularVelocity.length() });
					requireCondition(!hand.body && !hand.hit && hand.owner === 0, "爆炸也不能影響手中枚");
					const drawsAfter = draws, energiesAfter = targets.map((coin) => kineticEnergy(coin.body));
					requireCondition(!api.applyGroundImpact(entry) && draws === drawsAfter && api.game.lastGroundImpact === record, "同一連續接地不得再抽機率或替換結果");
					for (let index = 0; index < targets.length; index++) near(kineticEnergy(targets[index].body), energiesAfter[index], "爆炸重入不可累加擊飛能量");
					const physicalState = JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.body?.id]));
					api.animateCaptureEffects(1);
					requireCondition(api.game.effects.length === 0 && JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.body?.id])) === physicalState, "爆炸效果到期只能清理視覺");
					place(source, 12);
					place(friendly, -12);
					backface(friendly);
					settleGameBodies();
					requireCondition(friendly.faceBeforeThrow === 1 && api.isGameCoinResting(friendly), "爆炸己方免疫仍須有真初始基準及真最終支撐");
					api.finishGameTurn(true);
					requireCondition(friendly.owner === 0 && friendly.body, "爆炸擊中己方並翻面仍不得自行捕獲");
					await newGame();
					requireCondition(!api.game.groundImpactUsed && api.game.lastGroundImpact == null && api.game.effects.length === 0, "重開必須清空爆炸分支紀錄及特效");
					assertSix();
				}
			}
		}
		finally { Math.random = originalRandom; }
	}

	async function coveragePressureCheck() {
		let previousImpulse = Infinity;
		for (const side of [2, 4, 8]) {
			await newGame();
			const attacker = owned(0)[0], target = owned(0)[1];
			attacker.model = api.balanceGameModel(sampleRawRectangle(side, side));
			target.model = api.balanceGameModel(sampleRawRectangle(8, 8));
			place(target);
			settleGameBodies();
			requireCondition(api.selectGameCoin(attacker.id) && api.throwGameCoin(), "覆蓋測試須使用合法出手及己方受擊枚");
			attacker.body.position.set(0, 2, 0);
			const body = target.body;
			place(target);
			const edge = api.localPoint(target.model.cells.find((cell) => cell.row === 0 && cell.col === 3), target.model);
			const inner = api.localPoint(target.model.cells.find((cell) => cell.row === 2 && cell.col === 3), target.model);
			const center = api.localPoint(target.model.cells.find((cell) => cell.row === 3 && cell.col === 3), target.model);
			const profile = api.gameCoverProfile(target, attacker, edge), coverage = side ** 2 / 64, strength = 0.08 + 0.92 * (1 - coverage);
			near(profile.coverage, coverage, "同心解析矩形覆蓋率須為真像素面積比");
			near(profile.strength, strength, "邊緣強度須隨覆蓋率下降，完整覆蓋仍留8%受壓");
			const innerProfile = api.gameCoverProfile(target, attacker, inner);
			requireCondition(innerProfile.nearEdge, "筆畫內側兩格仍須算近邊緣");
			near(innerProfile.strength, strength * 0.2, "內側兩格按距離衰減而非硬當外邊");
			requireCondition(!api.gameCoverProfile(target, attacker, center).nearEdge && api.gameCoverProfile(target, attacker, center).strength === 0, "深筆畫中心不可冒充近邊緣");
			body.velocity.set(0.2, 2, -0.1);
			body.angularVelocity.set(1, 0, -1);
			const before = kineticEnergy(body), velocity = body.velocity.clone(), spin = body.angularVelocity.clone(), offset = body.quaternion.vmult(edge);
			const localSpin = body.quaternion.conjugate().vmult(spin), torque = edge.cross(body.quaternion.conjugate().vmult(body.position.clone().set(0, 1, 0)));
			const b = body.velocity.y + localSpin.dot(torque), k = 1 / body.mass + torque.x ** 2 / body.inertia.x + torque.y ** 2 / body.inertia.y + torque.z ** 2 / body.inertia.z;
			const energy = 1.2 * (0.75 - 0.5 * side ** 2 / 256) / 0.75 * strength, base = Math.min(0.8, (-b + Math.sqrt(b ** 2 + 2 * k * energy)) / k);
			const event = { /* body、contact：同一己方邊緣接觸，極高入射讓能量上限生效。 */ body: attacker.body, contact: { bi: body, ri: offset, getImpactVelocityAlongNormal: () => 1000000 } };
			api.handleGameContact(body, event);
			const impulse = (body.velocity.y - velocity.y) * body.mass;
			near(impulse, 2 * base, "覆蓋率須真正縮放己方近邊衝量，不能只顯示數值");
			near(kineticEnergy(body) - before, b * impulse + 0.5 * k * impulse ** 2, "覆蓋施力仍須完整計算線角動能交叉項");
			requireCondition(impulse < previousImpulse && target.assistUsed && target.hit && target.owner === 0, "覆蓋越多真助推越弱，己方可彈起但不直接捕獲");
			const after = kineticEnergy(body);
			api.handleGameContact(body, event);
			near(kineticEnergy(body), after, "己方近邊緣助推同樣每手只用一次");
			previousImpulse = impulse;
			place(attacker, 12);
			place(target, -12);
			backface(target);
			settleGameBodies();
			api.finishGameTurn(true);
			requireCondition(target.faceBeforeThrow === 1 && target.owner === 0 && target.body, "己方近邊彈起後即使背面停妥仍不能自行捕獲");
		}
	}

	async function collisionAudioCheck() {
		await newGame();
		const originalAudio = window.AudioContext, previous = { ...api.collisionAudio }, gains = [], stops = [];
		class FakeAudio {
			constructor() { this.state = "suspended"; this.currentTime = 1; this.sampleRate = 8000; this.destination = {}; }
			resume() { this.state = "running"; return Promise.resolve(); }
			createBuffer() { return { getChannelData: () => new Float32Array(640) }; }
			createGain() { return { gain: { setValueAtTime: (value) => gains.push(value), exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
			createOscillator() { return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop: (time) => stops.push(time) }; }
			createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop: (time) => stops.push(time) }; }
		}
		window.AudioContext = FakeAudio;
		Object.assign(api.collisionAudio, { context: null, noise: null, lastHits: new Map(), playCount: 0 });
		try {
			api.unlockGameAudio();
			requireCondition(api.collisionAudio.context?.state === "running", "音訊解鎖須建立及恢復AudioContext");
			const source = beginThrow(), body = place(source), other = api.state.floor, context = api.collisionAudio.context;
			const physical = JSON.stringify([body.position, body.quaternion, body.velocity, body.angularVelocity, source.owner]);
			requireCondition(!api.playCollisionSound(body, other, 0.39), "微小碰撞不可無限制發聲");
			requireCondition(api.playCollisionSound(body, other, 1000), "有效碰撞須排程音效");
			requireCondition(!api.playCollisionSound(other, body, 2), "同配對反向回呼80ms內也須去重");
			context.currentTime += 0.081;
			requireCondition(api.playCollisionSound(body, other, 2), "冷卻後的新碰撞可再發聲");
			requireCondition(gains.every((gain) => gain > 0 && gain <= 0.12) && stops.every(Number.isFinite), "聲音音量與生命週期須有界");
			requireCondition(JSON.stringify([body.position, body.quaternion, body.velocity, body.angularVelocity, source.owner]) === physical, "音效不可修改物理或所有權");
			context.currentTime += 1;
			const count = api.collisionAudio.playCount;
			body.position.y = 0.3;
			body.velocity.y = -3;
			body.aabbNeedsUpdate = true;
			for (let tick = 0; tick < 60 && api.collisionAudio.playCount === count; tick++) step(1);
			requireCondition(api.collisionAudio.playCount === count + 1, "真實多像素地面碰撞須觸發且去重為一次声音");
		}
		finally { window.AudioContext = originalAudio; Object.assign(api.collisionAudio, previous); }
	}

	async function graphemeAndFacesCheck() {
		await newGame();
		const originalCoins = [...api.game.coins], originalEpoch = api.game.epoch;
		for (const invalid of ["AB", "👍👍"]) {
			document.getElementById("p1-text-0").value = invalid;
			requireCondition(await api.startGame() === false, "每枚兩個字素必須拒絕，不能依UTF16長度錯算");
			requireCondition(api.game.epoch === originalEpoch && api.game.coins.every((coin, index) => coin === originalCoins[index]), "非法多字設定不能先破壞現行對局");
			requireCondition(document.getElementById("setup-status").textContent.length > 0, "多字拒絕須有可見設定提示");
		}
		document.getElementById("p1-text-0").value = "👩‍🚀";
		await api.startGame();
		const coin = api.game.coins[0];
		requireCondition(api.game.epoch > originalEpoch && coin.text === "👩‍🚀" && coin.model.cells.length > 0, "多碼點組合emoji仍是一個合法完整字素");
		const mesh = api.makeGlyphMesh(coin.model), [top, bottom] = mesh.material;
		requireCondition(top.map?.image === coin.model.canvas && bottom.map?.image === coin.model.canvas, "正反兩面都須使用原始字形彩色紋理，不能把emoji背面改為單色塊");
		requireCondition(top.color.getHex() !== bottom.color.getHex() && bottom.color.getHex() !== 0xffffff, "保留兩面原紋理時仍須用不同色調辨識正反");
		requireCondition(mesh.geometry.groups.some((group) => group.materialIndex === 0 && group.count > 0) && mesh.geometry.groups.some((group) => group.materialIndex === 1 && group.count > 0), "兩種彩色面材質必須實際覆蓋正反幾何");
		mesh.geometry.dispose();
		for (const texture of new Set(mesh.material.map((material) => material.map).filter(Boolean))) texture.dispose();
		for (const material of mesh.material) material.dispose();
		assertSix();
	}

	async function circularBattlefieldCheck() {
		await newGame();
		requireCondition(api.game.walls?.length >= 32 && api.game.walls.every((body) => body.mass === 0 && api.state.world.bodies.includes(body)), "圓周須有真正的低矮物理邊緣，不可只畫外框");
		requireCondition(api.state.camera.isOrthographicCamera, "正式戰場必須使用正交相機");
		const direction = api.state.camera.getWorldDirection(api.game.aim.clone());
		near(direction.x, 0, "視線必須垂直向下，不能有水平偏角");
		near(direction.y, -Math.cos(Math.PI / 12), "相機視線須為垂直向下再傾15度");
		near(direction.z, -Math.sin(Math.PI / 12), "相機須具有明確15度縱向傾角");
		for (const height of [floorHeight, 3]) {
			await newGame();
			const coin = owned(0)[0];
			coin.model = api.balanceGameModel(sampleRawRectangle(1, 1));
			const body = place(coin, 8.7);
			body.position.y = height;
			body.velocity.x = 4;
			body.aabbNeedsUpdate = true;
			let rimHits = 0;
			body.addEventListener("collide", (event) => { if (api.game.walls.includes(event.body)) rimHits++; });
			for (let tick = 0; tick < 42 && !rimHits; tick++) step(1);
			if (height === floorHeight) requireCondition(rimHits > 0 && body.velocity.x < 0 && Math.abs(body.velocity.x) < 1.5, `地面薄片須真正撞到圓周並小幅反彈：${JSON.stringify({ rimHits, position: body.position, velocity: body.velocity })}`);
			else requireCondition(rimHits === 0 && body.position.x > 9 && body.velocity.x > 0, "高飛薄片可越過低矮圓周，不可被無限高牆擋住");
			requireCondition(coin.owner === 0 && coin.body === body, "圓周接觸或越界不能直接淘汰或改所有權");
		}
		assertSix();
	}
	async function fixedCameraCheck() {
		for (const roll of [0.9, 0.1]) {
			await newGame();
			Math.random = () => roll;
			const camera = api.state.camera;
			function snapshotCamera() {
				camera.updateMatrixWorld(true);
				return JSON.stringify([camera.matrixWorld.toArray(), camera.projectionMatrix.toArray()]);
			}
			near(camera.position.x, 0, "固定鏡頭橫軸必須錨定原點");
			near(camera.position.y, 40, "固定鏡頭高度不可隨場上枚改變");
			near(camera.position.z, 40 * Math.tan(Math.PI / 12), "固定鏡頭縱向偏移須保持15度");
			const original = snapshotCamera(), source = owned(0)[0];
			api.game.aim.set(5, 0, -5);
			requireCondition(api.selectGameCoin(source.id) && api.throwGameCoin(), "固定鏡頭案例須真正投出偏離中央的薄片");
			requireCondition(snapshotCamera() === original, "投擲遠方落點不得改變相機姿態或投影");
			for (let tick = 0; tick < 600 && !api.game.groundImpactUsed; tick++) step(1);
			requireCondition(api.game.lastGroundImpact?.explosive === (roll < 0.25), "相機案例必須真正產生普通或爆炸落地效果");
			requireCondition(snapshotCamera() === original, "普通震波或大爆炸不得帶動相機");
			source.body.position.set(-120, 4, 130);
			source.body.velocity.set(2, 1, -3);
			source.body.wakeUp();
			source.body.aabbNeedsUpdate = true;
			api.fitBattleCamera();
			requireCondition(snapshotCamera() === original, "薄片散到遠方後重新適配也不得平移或縮放場景");
			settleGameBodies();
			api.finishGameTurn();
			requireCondition(api.game.status === "ready" && snapshotCamera() === original, "真正停妥換手後鏡頭仍必須完全不變");
		}
	}

	async function turnDeadlineCheck() {
		await newGame();
		const originalSetTimeout = window.setTimeout, originalClearTimeout = window.clearTimeout, originalNow = Date.now;
		const timers = new Map();
		let nextId = 100000, now = originalNow();
		window.setTimeout = (callback, delay, ...args) => {
			const id = nextId++;
			timers.set(id, { /* callback：可控原生排程回呼；delay：檢查真12秒；cleared：驗證生命週期清理。 */ callback: () => callback(...args), delay, cleared: false });
			return id;
		};
		window.clearTimeout = (id) => { if (timers.has(id)) timers.get(id).cleared = true; else originalClearTimeout(id); };
		Date.now = () => now;
		try {
			const enemy = owned(1)[0];
			place(enemy, -3);
			settleGameBodies();
			const source = beginThrow(), firstId = api.game.turnTimer, first = timers.get(firstId), initialTurn = api.game.turn;
			requireCondition(first?.delay === 12000 && api.game.turnDeadline === now + 12000, "成功出手必須設定原生12秒計時與真實時間截止");
			backface(enemy);
			enemy.hit = true;
			enemy.body.velocity.set(2, 0, 0);
			requireCondition(enemy.faceBeforeThrow === 1 && !api.isGameCoinResting(enemy), "逾時移動排除須有真初始基準且仍在運動");
			now += 12000;
			first.callback();
			requireCondition(api.game.status === "ready" && api.game.current === 1 && api.game.turn === initialTurn + 1, "原生計時到期必須切換一次真回合");
			requireCondition(enemy.owner === 1 && enemy.body && captureEffects().length === 0, "逾時不能捕獲尚在運動的背面敵枚");
			requireCondition(api.game.turnTimer == null && api.game.turnDeadline === 0 && first.cleared, "到期結算須清除計時器與截止時間");
			first.callback();
			requireCondition(api.game.turn === initialTurn + 1, "同一到期回呼重入不可多切一手");
			const secondSource = beginThrow(), second = timers.get(api.game.turnTimer), secondTurn = api.game.turn;
			first.callback();
			requireCondition(api.game.status === "simulating" && api.game.turn === secondTurn && api.game.thrownId === secondSource.id, "上一手回呼不能提前結束新一手");
			api.game.elapsed = 0;
			now = api.game.turnDeadline;
			api.animateGame(0.0001);
			requireCondition(api.game.status === "ready" && api.game.turn === secondTurn + 1 && second.cleared, "低幀率僅一個微小delta，真時間到期仍須換手");
			second.callback();
			requireCondition(api.game.turn === secondTurn + 1, "動畫截止與原生回呼競爭不得重複換手");
			beginThrow();
			const restartTimer = timers.get(api.game.turnTimer), oldEpoch = api.game.epoch;
			await newGame();
			restartTimer.callback();
			requireCondition(restartTimer.cleared && api.game.epoch > oldEpoch && api.game.status === "ready" && api.game.current === 0 && api.game.turnTimer == null && api.game.turnDeadline === 0, "重開須取消舊計時器且過期回呼不能污染新局");
			beginThrow();
			const leaveTimer = timers.get(api.game.turnTimer);
			api.leaveGame();
			const leftTurn = api.game.turn;
			leaveTimer.callback();
			requireCondition(leaveTimer.cleared && !api.game.active && api.game.turn === leftTurn && api.game.turnTimer == null && api.game.turnDeadline === 0, "離開後舊計時回呼不得復活對局或換手");
			await newGame();
			const finalSource = beginThrow(), normalTimer = timers.get(api.game.turnTimer);
			place(finalSource);
			settleGameBodies();
			api.finishGameTurn();
			requireCondition(normalTimer.cleared && api.game.status === "ready" && api.game.turnTimer == null && api.game.turnDeadline === 0, "正常停妥結算也必須清理逾時計時器");
			assertSix();
		}
		finally { window.setTimeout = originalSetTimeout; window.clearTimeout = originalClearTimeout; Date.now = originalNow; }
	}

	async function spawnSafetyCheck() {
		for (const fromBoard of [false, true]) {
			await newGame();
			const selected = owned(0)[0], enemy = owned(1)[0];
			selected.model = api.balanceGameModel(sampleRawRectangle(16, 16));
			enemy.model = api.balanceGameModel(sampleRawRectangle(16, 16));
			place(enemy);
			enemy.body.position.y = floorHeight + api.glyphPhysicsProfile(selected.model).height;
			enemy.body.aabbNeedsUpdate = true;
			if (fromBoard) {
				for (const [index, coin] of owned(0).entries()) place(coin, -3 + 3 * index, -2.5);
			}
			requireCondition(api.selectGameCoin(selected.id), "出生拒絕驗收必須由合法選枚開始");
			api.game.aim.set(0, 0, 0);
			api.game.angleDegrees = 15;
			const beforeBodies = api.game.coins.map((coin) => coin.body), worldBodies = [...api.state.world.bodies];
			const beforeState = JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.hit, coin.assistUsed, coin.body?.position, coin.body?.quaternion]));
			const turn = api.game.turn, current = api.game.current, thrownId = api.game.thrownId;
			requireCondition(!api.throwGameCoin(), "所有出生方向都與既有薄片重疊時必須拒絕，不能先拿起原牌");
			requireCondition(api.game.status === "ready" && api.game.turn === turn && api.game.current === current && api.game.thrownId === thrownId, "拒絕出生不得開始或消耗回合");
			requireCondition(api.game.turnTimer == null && api.game.turnDeadline === 0, "拒絕投擲不得建立回合逾時計時器");
			requireCondition(api.game.coins.every((coin, index) => coin.body === beforeBodies[index]), "拒絕出生不得刪除或替換任何桌面剛體");
			requireCondition(api.state.world.bodies.length === worldBodies.length && worldBodies.every((body) => api.state.world.bodies.includes(body)), "拒絕後物理世界必須維持原物件集合");
			requireCondition(JSON.stringify(api.game.coins.map((coin) => [coin.id, coin.owner, coin.hit, coin.assistUsed, coin.body?.position, coin.body?.quaternion])) === beforeState, "拒絕出生不得更改持有、接觸旗標或姿態");
			assertSix();
		}

		await newGame();
		const enemy = owned(1)[0];
		const obstacle = place(enemy, -2, 2);
		obstacle.position.y = floorHeight + 0.9;
		obstacle.aabbNeedsUpdate = true;
		const selected = owned(0)[0];
		requireCondition(api.selectGameCoin(selected.id), "安全出生應接受合法手中枚");
		api.game.aim.set(0, 0, 0);
		api.game.angleDegrees = 35;
		requireCondition(api.throwGameCoin(), "仍有不重疊方向時應尋找可用出生位置");
		selected.body.updateAABB();
		obstacle.updateAABB();
		const overlap = ["x", "y", "z"].every((axis) => Math.min(selected.body.aabb.upperBound[axis], obstacle.aabb.upperBound[axis]) > Math.max(selected.body.aabb.lowerBound[axis], obstacle.aabb.lowerBound[axis]));
		requireCondition(!overlap, "成功出生的實際碰撞 AABB 不得與既有疊牌重疊");
		const body = selected.body, energy = kineticEnergy(body) + body.mass * api.config.gravity * (body.position.y - floorHeight);
		const coverage = selected.model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
		const potential = body.mass * api.config.gravity * (body.position.y - floorHeight), remaining = 1.05 * 0.3 * api.config.gravity + 3 - 2 * coverage - potential;
		near(energy, potential + 0.7725 * remaining, "另尋安全出生方向不可增添已降低的發射能量");
		assertSix();
	}

	async function airborneSpinCheck() {
		const spins = [];
		for (const dimensions of [[4, 12], [12, 4]]) {
			await newGame();
			const coin = owned(0)[0];
			coin.model = api.balanceGameModel(sampleRawRectangle(...dimensions));
			api.game.angleDegrees = 35;
			requireCondition(api.selectGameCoin(coin.id) && api.throwGameCoin(), "不同質量分布必須由真實發射進入空中");
			const body = coin.body, model = coin.model;
			const grip = api.localPoint({ /* x、z：既定下緣握持點，用來獨立檢查角動量方向。 */ x: 0, z: api.config.size / 2 }, model);
			const velocity = body.quaternion.conjugate().vmult(body.velocity), omega = body.quaternion.conjugate().vmult(body.angularVelocity);
			const torque = grip.cross(velocity), momentum = omega.clone();
			for (const axis of ["x", "y", "z"]) momentum[axis] *= model.inertia[axis];
			requireCondition(torque.length() > 0 && momentum.length() > 0, "偏心發射必須產生非零空中角動量");
			requireCondition(torque.cross(momentum).length() / (torque.length() * momentum.length()) < 1e-8 && torque.dot(momentum) > 0, "角動量方向必須由力臂叉乘速度決定，不能套固定旋轉軸");
			const coverage = model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
			const potential = model.mass * api.config.gravity * (0.9 + 0.2 * (0.75 - 0.5 * coverage)), remaining = 1.05 * 0.3 * api.config.gravity + 3 - 2 * coverage - potential;
			const oldSpinEnergy = remaining - Math.min(0.75 * remaining, 18 * model.mass, 0.72 / model.mass), rawOmega = torque.clone();
			for (const axis of ["x", "y", "z"]) rawOmega[axis] /= model.inertia[axis];
			const rawEnergy = 0.5 * (model.inertia.x * rawOmega.x ** 2 + model.inertia.y * rawOmega.y ** 2 + model.inertia.z * rawOmega.z ** 2);
			const oldScale = Math.sqrt(oldSpinEnergy / rawEnergy);
			for (const axis of ["x", "y", "z"]) near(omega[axis], 0.3 * oldScale * rawOmega[axis], "初始角速應為相同字形原偏心發射角速的30%");
			spins.push(body.angularVelocity.clone());
		}
		requireCondition(spins[0].distanceTo(spins[1]) > 0.1, "相同覆蓋率但分布不同的字形必須有不同空中角速回應");
	}

	async function flatGeometryCheck() {
		await newGame();
		for (const coin of api.game.coins) {
			requireCondition(!coin.model.curve && coin.model.cells.every((cell) => cell.lift === undefined || cell.lift === 0), "正式字形模型必須恢復平板，不能殘留翹曲高度");
			const raw = api.balanceGameModel(api.sampleGlyph(coin.text, coin.font));
			for (const axis of ["x", "y", "z"]) near(coin.model.inertia[axis], raw.inertia[axis], "正式字形慣量必須為原平板分布");
			const body = api.makeGameBody(coin.model, api.game.aim.clone().set(0, 0, 0));
			assertBodyMask(body, coin.model);
			for (let index = 0; index < body.shapes.length; index++) {
				for (const point of shapeWorldVertices(body, index)) near(Math.abs(point.y), api.config.thickness / 2, "真正碰撞頂底必須平坦");
			}
			const mesh = api.makeGlyphMesh(coin.model), positions = mesh.geometry.getAttribute("position");
			for (let index = 0; index < positions.count; index++) requireCondition(Math.abs(positions.getY(index)) <= api.config.thickness / 2 + 2e-6, "可見字形必須回復平板厚度");
			let covered = 0;
			for (const group of mesh.geometry.groups) { near(group.start, covered, "平板材料群組不可遺漏三角形"); covered += group.count; }
			near(covered, positions.count, "所有可見字形三角形必須繪出");
			mesh.geometry.dispose();
		}
		for (const id of ["game-power", "game-restitution", "difficulty", "game-difficulty"]) requireCondition(!document.getElementById(id), "對局不得留下可調力度、反彈或難度的控制");
		requireCondition(document.getElementById("game-angle"), "只保留發射角度物理控制");
	}

	async function restitutionCheck() {
		const floorSpeeds = [], pairSpeeds = [];
		for (const alpha of [255, 64]) {
			await newGame();
			const model = api.balanceGameModel(sampleRawRectangle(16, 16, alpha));
			const coin = owned(0)[0];
			coin.model = model;
			const body = place(coin);
			const coverage = model.cells.reduce((sum, cell) => sum + cell.alpha, 0) / api.config.grid ** 2;
			const restitution = 0.72 + 0.2 * (0.75 - 0.5 * coverage) / 0.75;
			near(body.material.restitution, restitution, "每枚反彈材質必須由自身字形覆蓋率導出");
			near(body.material.friction, 0.3 + 0.2 * (0.25 + 0.5 * coverage), "每枚摩擦材質必須由自身字形防守份額導出");
			near(api.state.floor.material.restitution, 1, "桌面材質與個別字形共同決定反彈");
			near(api.state.world.defaultContactMaterial.restitution, 0.1, "遊戲不能污染實驗室預設反彈");
			body.position.y = 1;
			body.aabbNeedsUpdate = true;
			let maximum = 0, contacts = 0;
			const observeFloor = (event) => { if (event.body === api.state.floor) contacts++; };
			body.addEventListener("collide", observeFloor);
			for (let tick = 0; tick < 180; tick++) { step(1); maximum = Math.max(maximum, body.velocity.y); }
			requireCondition(contacts > 0, "字形反彈驗收必須真正接觸桌面");
			floorSpeeds.push(maximum);

			await newGame();
			const attackerCoin = owned(0)[0], victimCoin = owned(1)[0];
			attackerCoin.model = model;
			victimCoin.model = model;
			const attacker = place(attackerCoin, -3), victim = place(victimCoin, 0);
			const gravity = api.state.world.gravity.clone();
			try {
				// 暫停重力與轉動，隔離同質兩片真正碰撞；沒有可調反彈參數介入。
				api.state.world.gravity.set(0, 0, 0);
				for (const target of [attacker, victim]) { target.position.y = 2; target.angularFactor.set(0, 0, 0); target.linearDamping = 0; target.aabbNeedsUpdate = true; target.updateAABB(); }
				attacker.position.x += victim.aabb.lowerBound.x - attacker.aabb.upperBound.x - 0.01;
				attacker.aabbNeedsUpdate = true;
				attacker.velocity.x = 2;
				let hit = false;
				const observePair = (event) => { if (event.body === victim) hit = true; };
				attacker.addEventListener("collide", observePair);
				for (let tick = 0; tick < 30 && !hit; tick++) step(1);
				requireCondition(hit && victim.velocity.x > 0 && attacker.velocity.x < 2, "双方必須透過真正碰撞交換動量");
				pairSpeeds.push(victim.velocity.x - attacker.velocity.x);
			}
			finally { api.state.world.gravity.copy(gravity); }
		}
		requireCondition(floorSpeeds[1] > floorSpeeds[0] + 0.1, "較高字形反彈必須提高真實桌面回彈速度");
		requireCondition(floorSpeeds.every((speed) => speed > 2), "高彈性薄片實際落地回彈速度必須明顯高於舊低彈性");
		const denseRestitution = 0.72 + 0.2 * 0.25 / 0.75, sparseRestitution = 0.72 + 0.2 * (0.75 - 0.5 * 64 / 255) / 0.75;
		const idealDifference = 2 * (sparseRestitution ** 2 - denseRestitution ** 2);
		requireCondition(pairSpeeds[1] - pairSpeeds[0] > idealDifference * 0.5, "高彈性字形差異仍須提高真實雙片分離速度，尺度依材質乘積差計算");
	}
	async function lowSpeedRestitutionCheck() {
		for (const speed of [0.1, 2]) {
			await newGame();
			const coin = owned(0)[0], body = place(coin), profile = api.glyphPhysicsProfile(coin.model);
			body.velocity.y = -speed;
			let captured = null;
			body.addEventListener("collide", (event) => {
				if (event.body === api.state.floor && !captured) captured = { /* contact：本步真正接觸方程；impact：求解前實際入射速度。 */ contact: event.contact, impact: Math.abs(event.contact.getImpactVelocityAlongNormal()) };
			});
			for (let tick = 0; tick < 30 && !captured; tick++) step(1);
			requireCondition(captured && (captured.impact < 0.5) === (speed < 0.5), "低速耗散必須根據真正接觸相對速度區分");
			near(captured.contact.restitution, speed < 0.5 ? 0.22 : profile.restitution, "求解前僅低速接觸降低反彈，高速保留字形彈性");
			near(body.material.restitution, profile.restitution, "低速耗散不可永久修改字形材質");
			if (speed < 0.5) {
				settleGameBodies();
				requireCondition(api.isGameCoinResting(coin), "低速耗散後仍須以原門檻及真接地證據判停");
			}
		}
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
		for (let tick = 0; tick < 4200 && natural.body.sleepState !== 2; tick++) {
			step(1);
			api.isGameCoinResting(natural);
		}
		requireCondition(natural.body.sleepState === 2, `正常落地薄片必須能在35秒內自然睡眠：v=${natural.body.velocity.length()}、w=${natural.body.angularVelocity.length()}、y=${natural.body.position.y}`);
		step(6);
		requireCondition(api.isGameCoinResting(natural), "自然入睡的最後微小位移不能造成永久未停止");

		await newGame();
		const enemy = owned(1)[0];
		place(enemy, -4);
		step();
		const thrown = beginThrow();
		place(thrown, 4, 3);
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
		const lower = owned(1)[0];
		place(lower);
		step();
		const thrown = beginThrow();
		place(thrown, 4, 3);
		const upper = owned(0).find((coin) => coin !== thrown);
		backface(lower);
		place(upper);
		lower.body.updateAABB();
		upper.body.updateAABB();
		upper.body.position.y += lower.body.aabb.upperBound.y - upper.body.aabb.lowerBound.y + 0.003;
		upper.body.aabbNeedsUpdate = true;
		for (const coin of [lower, upper, thrown]) coin.body.allowSleep = false;
		for (let tick = 0; tick < 1200; tick++) {
			step(1);
			if ([lower, upper, thrown].every(api.isGameCoinResting)) break;
		}
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
	await check("正背雙向相對翻面、同面平面旋轉不捕獲", relativeFaceCheck);
	await check("初始空中、移動與側立不建立捕獲基準", missingFaceBaselineCheck);
	await check("多枚捕獲、五比一繼續、六比零勝利", multiAndWinCheck);
	await check("合法電腦規劃與重開世代清理", cpuAndRestartCheck);
	await check("電腦真實投擲與過期回呼隔離", cpuTimerCheck);
	await check("合併碰撞盒保留原遮罩、空洞、質量與慣量", mergedGeometryCheck);
	await check("遊戲投擲平移、旋轉、高度共用有界預算", gameEnergyCheck);
	await check("遊戲規範化保留原模型、密度攻防實際單調", normalizedBalanceCheck);
	await check("雙倍邊緣衝量、較低門檻與每枚一次限制", gameEdgeEnergyCheck);
	await check("像素覆蓋與內側近邊實際施力、己方彈起免捕獲", coveragePressureCheck);
	await check("碰撞音效解鎖、真接觸去重、有界音量且不改物理", collisionAudioCheck);
	await check("真實接觸求解後助推、一次性與重開佇列清理", deferredContactCheck);
	await check("真離地再落地重新衝擊、同次接地去重與視覺清理", groundImpactLifecycleCheck);
	await check("震波三維範圍衰減、共享動能預算及己方免疫", groundImpactBudgetCheck);
	await check("首次落地機率爆炸、大範圍有界擊飛與捕獲隔離", explosionBranchCheck);
	await check("單字素限制、組合emoji及正反兩面彩色紋理", graphemeAndFacesCheck);
	await check("圓形低邊界真實小反彈、高飞可越及15度正交視角", circularBattlefieldCheck);
	await check("投擲、爆炸、散開及結算不移動場景座標", fixedCameraCheck);
	await check("真時間逾時換手、低幀率補救及舊計時器隔離", turnDeadlineCheck);
	await check("安全出生保留能量、受阻拒絕不改原對局", spawnSafetyCheck);
	await check("偏心握持及不同質量分布產生空中角運動", airborneSpinCheck);
	await check("平板碰撞與視覺、原慣量及只保留角度控制", flatGeometryCheck);
	await check("字形自動反彈實際影響桌面及雙片碰撞", restitutionCheck);
	await check("真接觸相對速度耗散、高速強彈及材質不變", lowSpeedRestitutionCheck);
	await check("睡眠接觸省略後仍停止、移至空中快取失效", sleepingSupportCheck);
	await check("睡眠疊放支撐、捕獲下層後喚醒與失效", supportedStackRemovalCheck);
	await check("新投擲清除前回合支撐紀錄並喚醒桌面枚", newThrowInvalidatesSupportCheck);
	return { /* passed：實際通過流程；failures：失敗原因；measurements：固定fixture真正物理回應，不能外推所有字形。 */ passed, failures, measurements };
}

// 必須以非零退出碼保留錯誤，不把測試寫完當成遊戲驗收成功。
main().catch((error) => { console.error(error); process.exitCode = 1; });
