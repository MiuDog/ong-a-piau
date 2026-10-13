// 使用產品的瀏覽器模組驗證攻防分配與實際剛體，不以畫面分數代替物理結果。
const { chromium } = require("C:/Users/ASUS_TUF/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");

async function main() {

	// 關閉自動動畫，所有量測均在已知發射瞬間或固定模擬步數進行。
	const browser = await chromium.launch({ /* executablePath：沿用驗證環境的 Chrome；headless：避免干擾桌面。 */ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
	try {
		const page = await browser.newPage();
		const errors = [];
		const recordError = (error) => errors.push(error.message);
		await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
		page.on("pageerror", recordError);
		await page.route("http://127.0.0.1:5173/", instrumentRoute);
		await page.goto("http://127.0.0.1:5173/");
		await page.waitForFunction(() => window.__balance?.state.model != null, null, { /* timeout：容許字體／CDN載入；polling：不用已被停用的動畫排程。 */ timeout: 45000, polling: 100 });
		const result = await page.evaluate(runChecks);
		assert.deepEqual(errors, [], "產品模組不得發生執行錯誤");
		assert.deepEqual(result.failures, [], result.failures.join("\n"));
		console.log(JSON.stringify(result, null, 2));
	}
	finally {
		await browser.close();
	}
}

async function instrumentRoute(route) {

	// 僅暴露已約定的產品接點，不改動實際公式、參數或物理引擎。
	const response = await route.fetch();
	const exposed = "window.__balance = { state, config, sampleGlyph, localPoint, reset, balanceProfile, launchBudget, launch, edgeProfile, assistEdgeCollision, drop, settle }; </script>";
	const html = (await response.text()).replace("</script>", exposed);
	await route.fulfill({ /* response：保留原回應設定；body：加入測試接點的頁面。 */ response, body: html });
}

function runChecks() {

	const api = window.__balance;
	const passed = [], failures = [];
	const capacity = api.config.density * api.config.thickness * api.config.size ** 2;

	function near(actual, expected, label) {
		if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-8 * Math.max(1, Math.abs(expected))) throw new Error(`${label}: ${actual} != ${expected}`);
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

	function sample(columns, rows, alpha = 255) {
		// 固定矩形覆蓋率以取得獨立面積答案；不讀產品回傳的 coverage 作為預期。
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

	function expectedBudget(coverage, power) {
		const mass = capacity * coverage;
		const energyBudget = 0.8 * (0.75 - 0.5 * coverage) * power ** 2;
		const impulse = Math.min(Math.sqrt(2 * mass * energyBudget), mass * 6, 1.2);
		return { /* mass：解析質量；energyBudget：獨立計算的分配預算；impulse：三重限制後衝量；energy：實際可注入總能量；speed：全動能情況的速度上限。 */ mass, energyBudget, impulse, energy: impulse ** 2 / (2 * mass), speed: impulse / mass };
	}

	function profileCheck() {
		let previousOffense = Infinity, previousDefense = -Infinity;
		for (const dimensions of [[1, 1], [4, 8], [12, 12], [16, 16]]) {
			const coverage = dimensions[0] * dimensions[1] / 256;
			const model = sample(dimensions[0], dimensions[1]);
			const profile = api.balanceProfile(model);
			near(model.mass, capacity * coverage, "質量仍由共同材料與面積求得");
			near(profile.coverage, coverage, "解析覆蓋率");
			near(profile.offense, 0.75 - 0.5 * coverage, "進攻份額");
			near(profile.defense, 0.25 + 0.5 * coverage, "防守份額");
			near(profile.offense + profile.defense, 1, "攻防總份額");
			near(profile.angularDamping, 0.08 + 0.24 * profile.defense, "遊戲角阻尼");
			requireCondition(profile.offense < previousOffense && profile.defense > previousDefense, "筆畫密度增加必須降低進攻分配、提高防守分配");
			previousOffense = profile.offense;
			previousDefense = profile.defense;
		}
		const partial = api.balanceProfile(sample(4, 8, 128));
		near(partial.coverage, 0.125 * 128 / 255, "alpha 是覆蓋率，不是材料密度");
	}

	function budgetCheck() {
		for (const dimensions of [[1, 1], [4, 8], [12, 12]]) {
			const coverage = dimensions[0] * dimensions[1] / 256;
			const model = sample(dimensions[0], dimensions[1]);
			for (const power of [0, 0.5, 1]) {
				const actual = api.launchBudget(model, power), expected = expectedBudget(coverage, power);
				for (const key of ["energyBudget", "impulse", "speed", "energy"]) near(actual[key], expected[key], `發射預算 ${key}`);
				requireCondition(actual.speed <= 6 + 1e-9 && actual.impulse <= 1.2 + 1e-9, "稀疏字仍必須遵守速度與衝量上限");
				requireCondition(actual.energy <= actual.energyBudget + 1e-9, "實際發射能量不得超過分配");
			}
		}
		const model = sample(4, 8);
		for (const power of [-1, NaN, Infinity]) near(api.launchBudget(model, power).energy, 0, "負值或非有限力度不得發射");
		near(api.launchBudget(model, 2).energy, api.launchBudget(model, 1).energy, "超出最大力度必須截斷");
	}

	function inputCheck() {
		let blankRejected = false;
		try {
			api.sampleGlyph(" ", "sans-serif");
		}
		catch {
			blankRejected = true;
		}
		requireCondition(blankRejected, "空白必須拒絕生成薄片");
		for (const mass of [0, -1, NaN, Infinity]) {
			const invalid = { /* mass：刻意無效的質量，驗證邊界不產生NaN；cells：空幾何，不應啟動發射。 */ mass, cells: [] };
			const budget = api.launchBudget(invalid, 1);
			for (const key of ["energyBudget", "impulse", "speed", "energy"]) near(budget[key], 0, `無效形體 ${key}`);
		}
		const emoji = api.sampleGlyph("🐱", "sans-serif");
		const profile = api.balanceProfile(emoji), budget = api.launchBudget(emoji, 1);
		requireCondition(profile.coverage > 0 && profile.coverage <= 1, "emoji 必須有有限有效覆蓋率");
		for (const key of ["energyBudget", "impulse", "speed", "energy"]) requireCondition(Number.isFinite(budget[key]) && budget[key] >= 0, `emoji ${key} 必須有限`);
	}

	function launchCheck() {
		for (const dimensions of [[1, 1], [4, 8], [12, 12]]) {
			const model = sample(dimensions[0], dimensions[1]);
			const coverage = dimensions[0] * dimensions[1] / 256;
			api.state.model = model;
			api.state.selected = 0;
			document.getElementById("throw-power").value = "1";
			api.launch();
			const body = api.state.target, expected = expectedBudget(coverage, 1);
			const height = Math.min(0.6, expected.energy / (2 * expected.mass * api.config.gravity));
			const kinetic = expected.energy - expected.mass * api.config.gravity * height;
			const actualHeight = body.position.y - (api.config.thickness / 2 + 0.003);
			const actualKinetic = 0.5 * body.mass * body.velocity.lengthSquared();
			near(body.mass, expected.mass, "實際發射字形質量");
			near(body.angularDamping, 0.08 + 0.24 * (0.25 + 0.5 * coverage), "防守耗散確實設定至剛體");
			near(actualHeight, height, "起始高度由同一能量預算分配");
			near(body.velocity.x, Math.sqrt(2 * kinetic / expected.mass), "重心衝量產生實際速度");
			near(body.velocity.y, 0, "不暗加上拋速度");
			near(body.velocity.z, 0, "不暗加側向速度");
			near(body.angularVelocity.length(), 0, "重心發射不暗加旋轉");
			near(actualKinetic + body.mass * api.config.gravity * actualHeight, expected.energy, "重力位能與動能共同遵守實際預算");
			requireCondition(body.shapes.length === model.cells.length, "發射物必須是字形碰撞體，不能換成固定測試球");
			requireCondition(api.state.model === model, "發射不得偷換字形物性模型");
		}
	}

	function dampingCheck() {
		const retained = [];
		for (const dimensions of [[4, 8], [12, 12]]) {
			api.state.model = sample(dimensions[0], dimensions[1]);
			api.state.selected = 0;
			api.reset();
			const body = api.state.target;
			body.position.y = 30;
			body.angularVelocity.set(0, 1, 0);
			body.wakeUp();
			for (let tick = 0; tick < 120; tick++) api.state.world.step(1 / 120);
			retained.push(body.angularVelocity.length());
		}
		requireCondition(retained[1] < retained[0] - 0.02, "高密度的較高角阻尼必須真的耗散更多旋轉");
	}

	function edgeProfileCheck() {
		const sparse = sample(1, 1), solid = sample(12, 12);
		const sparseEdge = api.edgeProfile(sparse, api.localPoint(sparse.cells[0], sparse));
		const broadEdge = api.edgeProfile(solid, api.localPoint(solid.cells[0], solid));
		const inside = solid.cells.find((cell) => cell.row === 5 && cell.col === 5);
		const interior = api.edgeProfile(solid, api.localPoint(inside, solid));
		requireCondition(sparseEdge.edge && broadEdge.edge && !interior.edge, "邊界格與內部格應正確區分");
		requireCondition(sparseEdge.gain > broadEdge.gain && broadEdge.gain > 1, "同接觸足跡下較少筆畫面積才有較大加成");
		near(interior.gain, 1, "內部命中不給邊緣加成");
		for (const profile of [sparseEdge, broadEdge, interior]) {
			requireCondition(Number.isFinite(profile.gain) && profile.gain >= 1 && profile.gain <= 2.9 + 1e-9, "單格稀疏字也不能得到無界加成");
			requireCondition(profile.fraction >= 0.05 && profile.fraction <= 1, "接觸覆蓋率必須有界");
		}
	}

	function kineticEnergy(body) {
		// 從前後剛體速度獨立計算總動能，避免只相信加成函式回報的 energy。
		const localOmega = body.quaternion.conjugate().vmult(body.angularVelocity);
		const rotation = body.inertia.x * localOmega.x ** 2 + body.inertia.y * localOmega.y ** 2 + body.inertia.z * localOmega.z ** 2;
		return 0.5 * body.mass * body.velocity.lengthSquared() + 0.5 * rotation;
	}

	function edgeEnergyCheck() {
		api.state.model = sample(4, 8);
		api.state.selected = 0;
		api.drop();
		const body = api.state.target;
		body.quaternion.setFromEuler(0.4, 0.3, -0.2);
		body.updateInertiaWorld(true);
		body.updateSolveMassProperties();
		body.velocity.set(0.2, 2, -0.1);
		body.angularVelocity.set(3, 1, -2);
		const point = api.localPoint(api.state.model.cells[0], api.state.model);
		point.y = api.config.thickness / 2;
		const offset = body.quaternion.vmult(point);
		const event = {
			/* body：只有本次測試球可觸發；contact：指定已知力臂與高速接觸，用於單獨驗證能量上限。 */
			body: api.state.ball,
			contact: {
				/* bi、bj：接觸剛體；ri、rj：世界相對重心偏移；getImpactVelocityAlongNormal：高入射速度迫使能量上限生效。 */
				bi: body, bj: api.state.ball, ri: offset, rj: offset,
				getImpactVelocityAlongNormal: () => 1000000
			}
		};
		const before = kineticEnergy(body);
		api.assistEdgeCollision(event);
		const after = kineticEnergy(body), report = api.state.lastAssist;
		requireCondition(report && report.impulse > 0, "邊缘加成必須真的施加衝量");
		requireCondition(after - before <= 0.12 + 1e-8, "既有平移／旋轉下，總動能增量仍不得超過0.12J");
		near(report.energy, after - before, "回報必須含完整平移與旋轉交叉項");
		api.assistEdgeCollision(event);
		near(kineticEnergy(body), after, "同回合重複接觸不能重複放大");
	}

	function edgeCollisionCheck() {
		api.state.model = sample(4, 8);
		api.state.selected = 0;
		api.drop();
		let collisions = 0, assists = 0, previous = null;
		function recordContact(event) {
			if (event.body !== api.state.ball) return;

			collisions++;
			if (api.state.lastAssist && api.state.lastAssist !== previous) {
				assists++;
				previous = api.state.lastAssist;
			}
		}
		api.state.target.addEventListener("collide", recordContact);
		for (let tick = 0; tick < 1200; tick++) api.state.world.step(1 / 240);
		requireCondition(collisions > 0 && assists === 1, "真實球碰撞必須接上一次且僅一次邊緣加成");
		requireCondition(api.state.lastAssist.energy <= 0.12 + 1e-8, "真實接觸也必須記錄受限能量");

		// 保留本次真實助推記錄，將薄片放回正面穩定接觸；曾彈起不能覆寫最終朝向判定。
		const body = api.state.target;
		body.position.set(0, api.config.thickness / 2 + 0.003, 0);
		body.quaternion.setFromEuler(0, -api.state.model.angle, 0);
		body.velocity.set(0, 0, 0);
		body.angularVelocity.set(0, 0, 0);
		body.updateInertiaWorld(true);
		body.wakeUp();
		api.state.world.removeBody(api.state.ball);
		for (let tick = 0; tick < 360; tick++) api.state.world.step(1 / 120);
		api.state.running = true;
		api.state.quiet = 1;
		api.state.elapsed = 2;
		api.settle();
		const status = document.getElementById("status").textContent;
		requireCondition(/正面朝上/.test(status) && !/翻面成功/.test(status), "最終正面朝上，即使曾有邊緣加成也不能算成功");
	}

	check("覆蓋率及有界攻防單調分配", profileCheck);
	check("解析能量／速度／衝量預算與力度截斷", budgetCheck);
	check("空白、無效質量、emoji 邊界", inputCheck);
	check("真實字形發射及重力／動能共同預算", launchCheck);
	check("角阻尼實際影響物理運動", dampingCheck);
	check("邊缘小面積有界加成、內部無加成", edgeProfileCheck);
	check("偏心衝量完整動能上限與重複接觸保護", edgeEnergyCheck);
	check("真實球觸發一次加成、最終正面不淘汰", edgeCollisionCheck);
	return { /* passed：已執行通過的必要測試；failures：所有失敗原因，禁止放寬預期或跳過。 */ passed, failures };
}

// 失敗必須保留非零退出碼，不能以成功啟動瀏覽器當作驗收通過。
main().catch((error) => { console.error(error); process.exitCode = 1; });
