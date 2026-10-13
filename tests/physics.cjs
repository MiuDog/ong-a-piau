// 使用既有瀏覽器執行真正產品模組，避免另寫一份物理實作冒充驗證。
const { chromium } = require("C:/Users/ASUS_TUF/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");

async function main() {

	// 停用動畫排程，由測試固定步進，確保取樣與衝量之間沒有非預期模擬。
	const launchOptions = { /* executablePath：沿用已知 Chrome；headless：避免干擾使用者桌面。 */ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true };
	const browser = await chromium.launch(launchOptions);
	try {
		const page = await browser.newPage();
		const errors = [];
		const recordError = (error) => errors.push(error.message);
		await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
		page.on("pageerror", recordError);
		await page.route("http://127.0.0.1:5173/", instrumentRoute);
		await page.goto("http://127.0.0.1:5173/");
		await page.waitForFunction(() => window.__physics?.state.model != null, null, { /* timeout：字體與 CDN 首次載入容許時間；polling：動畫已停用，改以計時器觀察啟動。 */ timeout: 45000, polling: 100 });
		const result = await page.evaluate(runPhysicsChecks);
		assert.deepEqual(errors, [], "產品頁不得發生執行錯誤");
		assert.deepEqual(result.failures, [], result.failures.join("\n"));
		console.log(JSON.stringify(result, null, 2));
	}
	finally {
		await browser.close();
	}
}

async function instrumentRoute(route) {

	// 只在此測試的回應加入既有接點，不修改產品來源或測試預期值。
	const response = await route.fetch();
	const exposed = "window.__physics = { state, config, sampleGlyph, localPoint, reset, lift, drop, settle }; </script>";
	const html = (await response.text()).replace("</script>", exposed);
	await route.fulfill({ /* response：保留原回應標頭；body：加入唯測試可見的模組接點。 */ response, body: html });
}

function runPhysicsChecks() {

	const api = window.__physics;
	const passed = [], failures = [];
	const rectangle = [[-0.375, 0.375, -0.25, 0.25]];
	const elbow = [[-0.25, 0, -0.25, 0.25], [0, 0.25, 0, 0.25]];
	const originalDensity = api.config.density;

	function near(actual, expected, label) {
		if (Math.abs(actual - expected) > 1e-8 * Math.max(1, Math.abs(expected))) throw new Error(`${label}: ${actual} != ${expected}`);
	}

	function requireCondition(value, label) {
		if (!value) throw new Error(label);
	}

	function check(label, action) {
		try {
			action();
			passed.push(label);
		}
		catch (error) {
			failures.push(`${label}: ${error.message}`);
		}
	}

	function sample(rectangles, alpha = 255) {
		// 注入已知面積的合成 alpha 影像，排除系統字體、筆畫抗鋸齒的不確定性。
		const original = CanvasRenderingContext2D.prototype.getImageData;
		function knownImage(x, y, width, height) {
			const image = original.call(this, x, y, width, height);
			image.data.fill(0);
			for (let row = 0; row < height; row++) {
				for (let col = 0; col < width; col++) {
					const px = (col + 0.5) / width - 0.5, pz = (row + 0.5) / height - 0.5;
					const contained = (rect) => px >= rect[0] && px < rect[1] && pz >= rect[2] && pz < rect[3];
					if (rectangles.some(contained)) image.data[(row * width + col) * 4 + 3] = alpha;
				}
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

	function analytic(rectangles, coverage = 1) {
		// 對整個解析長方體積分，再合併其張量；不讀取产品細格或主軸計算結果。
		const size = api.config.size, thickness = api.config.thickness;
		const parts = [];
		for (const rect of rectangles) {
			const width = (rect[1] - rect[0]) * size, depth = (rect[3] - rect[2]) * size;
			parts.push({ /* mass：解析體積質量；x、z：矩形中心；width、depth：完整形體尺寸，用於閉式慣量。 */ mass: width * depth * thickness * api.config.density * coverage, x: (rect[0] + rect[1]) * size / 2, z: (rect[2] + rect[3]) * size / 2, width, depth });
		}
		const mass = parts.reduce((sum, part) => sum + part.mass, 0);
		const cx = parts.reduce((sum, part) => sum + part.mass * part.x, 0) / mass;
		const cz = parts.reduce((sum, part) => sum + part.mass * part.z, 0) / mass;
		let xx = 0, yy = 0, zz = 0, xz = 0;
		for (const part of parts) {
			const dx = part.x - cx, dz = part.z - cz;
			xx += part.mass * ((part.depth ** 2 + thickness ** 2) / 12 + dz ** 2);
			zz += part.mass * ((part.width ** 2 + thickness ** 2) / 12 + dx ** 2);
			yy += part.mass * ((part.width ** 2 + part.depth ** 2) / 12 + dx ** 2 + dz ** 2);
			xz -= part.mass * dx * dz;
		}
		return { /* mass、cx、cz：解析質量與重心；xx、yy、zz、xz：世界初始座標的慣量張量，不依賴產品主軸。 */ mass, cx, cz, xx, yy, zz, xz };
	}

	function install(model, selected = 0) {
		api.state.model = model;
		api.state.selected = selected;
		api.reset();
	}

	function verifyModel(model, expected) {
		near(model.mass, expected.mass, "mass");
		near(model.cx, expected.cx, "COM x");
		near(model.cz, expected.cz, "COM z");
		near(model.inertia.y, expected.yy, "Iy");
		near(model.inertia.x + model.inertia.z, expected.xx + expected.zz, "主慣量之和");
		near(model.inertia.x * model.inertia.z, expected.xx * expected.zz - expected.xz ** 2, "主慣量乘積");
	}

	function verifyImpulse(model, expected) {
		// 由未對角化的解析張量直接解世界角速度，能抓到主軸角度或座標正負號錯誤。
		const impulse = 0.6;
		document.getElementById("impulse").value = String(impulse);
		api.lift();
		const cell = model.cells[api.state.selected];
		const tx = -(cell.z - expected.cz) * impulse, tz = (cell.x - expected.cx) * impulse;
		const determinant = expected.xx * expected.zz - expected.xz ** 2;
		const omega = api.state.target.angularVelocity;
		near(api.state.target.velocity.y, impulse / expected.mass, "Δv = J/M");
		near(omega.x, (expected.zz * tx - expected.xz * tz) / determinant, "世界 ωx");
		near(omega.z, (expected.xx * tz - expected.xz * tx) / determinant, "世界 ωz");
		near(omega.y, 0, "垂直衝量不產生 y 軸力矩");
		return omega.length();
	}

	function rectangleCheck() {
		const model = sample(rectangle), expected = analytic(rectangle);
		verifyModel(model, expected);
		near(model.support, api.config.size / 4, "矩形最短支撐距離");
		const height = api.config.thickness / 2, distance = api.config.size / 4;
		near(model.stability, expected.mass * api.config.gravity * (Math.hypot(distance, height) - height), "解析能障");
		install(model);
		verifyImpulse(model, expected);
	}

	function asymmetricCheck() {
		const model = sample(elbow), expected = analytic(elbow);
		requireCondition(Math.abs(expected.xz) > 0.00001, "fixture 必須具有非零交叉慣量");
		verifyModel(model, expected);
		install(model);
		verifyImpulse(model, expected);
		const body = api.state.target;
		for (let index = 0; index < model.cells.length; index++) {
			const point = body.pointToWorldFrame(body.shapeOffsets[index]);
			near(point.x, model.cells[index].x, "碰撞格世界 x");
			near(point.z, model.cells[index].z, "碰撞格世界 z");
		}
	}

	function materialCheck() {
		const full = sample(rectangle);
		const covered = sample(rectangle, 128);
		verifyModel(covered, analytic(rectangle, 128 / 255));
		near(covered.mass / full.mass, 128 / 255, "alpha 是體積覆蓋率");
		try {
			api.config.density = originalDensity * 2;
			const dense = sample(rectangle), expected = analytic(rectangle);
			near(dense.mass / full.mass, 2, "材料密度倍率");
			install(dense);
			const denseSpeed = verifyImpulse(dense, expected);
			api.config.density = originalDensity;
			install(full);
			const lightSpeed = verifyImpulse(full, analytic(rectangle));
			near(lightSpeed / denseSpeed, 2, "密度真的改變旋轉反應");
		}
		finally {
			api.config.density = originalDensity;
		}
	}

	function leverageCheck() {
		const model = sample(rectangle), expected = analytic(rectangle);
		const closest = model.cells.reduce((best, cell, index) => Math.hypot(cell.x, cell.z) < Math.hypot(model.cells[best].x, model.cells[best].z) ? index : best, 0);
		install(model, closest);
		const centerSpeed = verifyImpulse(model, expected);
		install(model, 0);
		const edgeSpeed = verifyImpulse(model, expected);
		requireCondition(edgeSpeed > centerSpeed * 3, "同薄片遠端力臂應产生更大角速度");
	}

	function setPose(angle, height) {
		api.reset();
		const body = api.state.target;
		body.quaternion.setFromEuler(angle, 0, 0);
		body.position.set(0, height, 0);
		body.velocity.set(0, 0, 0);
		body.angularVelocity.set(0, 0, 0);
		body.updateInertiaWorld(true);
		body.wakeUp();
		api.state.running = true;
		api.state.elapsed = 2;
		api.state.quiet = 1;
		document.getElementById("status").textContent = "尚未判定";
	}

	function verdictCheck() {
		install(sample(rectangle));
		for (const angle of [0, Math.PI]) {
			setPose(angle, api.config.thickness / 2 + 0.003);
			for (let tick = 0; tick < 360; tick++) api.state.world.step(1 / 120);
			api.settle();
			const status = document.getElementById("status").textContent;
			const expected = angle === 0 ? /正面朝上/ : /背面朝上.*翻面成功/;
			requireCondition(expected.test(status), `接觸桌面後應正確判面：${status}`);
		}
		// 保留上一段背面朝上的真實桌面接觸，再分別加入速度，避免只測到「沒接觸」的拒判。
		for (const velocity of [api.state.target.velocity, api.state.target.angularVelocity]) {
			api.state.target.velocity.set(0, 0, 0);
			api.state.target.angularVelocity.set(0, 0, 0);
			velocity.set(0.5, 0, 0);
			api.state.running = true;
			document.getElementById("status").textContent = "尚未判定";
			api.settle();
			requireCondition(!/翻面成功/.test(document.getElementById("status").textContent), "有桌面接觸但仍移動或旋轉，不可判翻面");
		}
		setPose(Math.PI, 5);
		api.settle();
		requireCondition(!/翻面成功/.test(document.getElementById("status").textContent), "空中靜止瞬間不可判翻面");
		setPose(Math.PI / 2, api.config.size / 4 - 0.001);
		api.state.world.step(1 / 240);
		api.state.target.velocity.set(0, 0, 0);
		api.state.target.angularVelocity.set(0, 0, 0);
		const touchesFloor = (contact) => (contact.bi === api.state.target && contact.bj === api.state.floor) || (contact.bj === api.state.target && contact.bi === api.state.floor);
		requireCondition(api.state.world.contacts.some(touchesFloor), "側立 fixture 必須先取得真實桌面接觸");
		api.settle();
		requireCondition(!/翻面成功/.test(document.getElementById("status").textContent), "側立不能判背面");
	}

	function collisionCheck() {
		install(sample(rectangle));
		api.drop();
		let collisions = 0, peakAngularSpeed = 0;
		const recordContact = (event) => { if (event.body === api.state.ball) collisions++; };
		api.state.target.addEventListener("collide", recordContact);
		for (let tick = 0; tick < 1200; tick++) {
			api.state.world.step(1 / 240);
			peakAngularSpeed = Math.max(peakAngularSpeed, api.state.target.angularVelocity.length());
		}
		requireCondition(collisions > 0, "測試球必須真正接觸薄片");
		requireCondition(peakAngularSpeed > 0.001, "偏心撞擊必須傳遞角動量");
	}

	check("解析矩形：質量、重心、慣量、支撐與衝量", rectangleCheck);
	check("不對稱 L：交叉慣量與世界座標旋轉", asymmetricCheck);
	check("覆蓋率、密度與實際運動反應", materialCheck);
	check("施力位置真的影響角速度", leverageCheck);
	check("桌面接觸與靜止翻面判定", verdictCheck);
	check("測試球接觸求解與動量傳遞", collisionCheck);
	return { /* passed：完整執行成功的必要測試；failures：每個失敗原因，禁止用忽略項目取得通過。 */ passed, failures };
}

// 集中捕捉驗證失敗並以非零退出碼回報，不能把「寫了測試」當作「測試通過」。
main().catch((error) => { console.error(error); process.exitCode = 1; });
