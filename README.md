# 尪仔標：硬幣版

以台灣童玩尪仔標的翻面玩法為靈感，透過 AI 協助實作的 3D 文字／emoji 投擲對戰遊戲。

[開啟網站](https://miudog.github.io/ong-a-piau/)

## 玩法與操作

- 單人對電腦，或同一裝置雙人輪流；每人三枚。
- 每枚限一個完整文字或 emoji，組合 emoji 算一個，可選不同字體；正反面都保留彩色字形。
- 從四周外圍往內拖曳，放開投擲；滑越快投得越快，可調投擲仰角。
- 圓形場地、正方形顯示區及固定鏡頭；玩家與電腦都從場內朝內投擲，碰到邊界會小幅向內反彈。
- 真碰撞有音效；近邊覆蓋越多，撬起助推越小。
- 本手投出枚每次真正離地後向下落地，都有範圍衝擊及25%爆炸機率。
- 命中的對手枚穩定落地後，朝上面與受擊前相反才被奪取；己方不會被自己奪取。
- 手上優先，沒有手牌才拿起自己的場上枚；取得全部六枚、形成6：0即獲勝。每手最多等待12秒。

## 關鍵檔案

| 位置 | 用途 |
| --- | --- |
| [index.html](index.html) | 可操作的唯一網頁入口；本專案自行撰寫的 CSS 與 JavaScript 均寫在此檔內。 |
| [docs/specification.md](docs/specification.md) | 現行玩法、介面、物理規則及交付規格，獨立於 README。 |
| [docs/development.md](docs/development.md) | 與 AI 討論後反覆調整的實作歷程、問題修正與截圖連結。 |
| [docs/images/](docs/images/) | 網站介面與歷次修改截圖；目前場內投擲畫面見 [inward-boundary.png](docs/images/inward-boundary.png)。 |
| [docs/physics-model.md](docs/physics-model.md) | 字形取樣、重心、慣量、校準公式、參考來源與近似限制。 |
| [docs/game-validation.md](docs/game-validation.md) | 對局、捕獲、投擲、邊界與碰撞驗收條件。 |
| [architecture.md](architecture.md) | 程式結構、函式責任與呼叫流程。 |
| [tests/](tests/) | `physics.cjs`、`balance.cjs`、`game.cjs`：物理、攻防與對局測試，不是網站執行所需檔案。 |

## 檔案架構與作業要求

```text
index.html                 網站入口，內含自行撰寫的樣式與互動程式
README.md                  使用說明與檔案導覽
architecture.md            程式架構
docs/                      規格、修改紀錄、物理說明與截圖
tests/                     開發驗收用測試
```

- 網站以根目錄的單一 `index.html` 交付，無需安裝套件或執行建置；其他目錄是作業說明及開發驗證資料。
- 透過 GitHub Pages 公開網站；繳交時可使用網站連結、`docs/images/` 的截圖、規格書與修改紀錄。
- 初次開啟需網路載入 Three.js 0.170.0、cannon-es 0.20.0 與 Noto 字體；裝置字體與 emoji 外觀可能不同。
- 開發期間的暫存及檢查資料位於 `.qa/`，由 `.gitignore` 排除，不包含在公開版本中。
- AI 協作與實際參考來源保存在規格及修改紀錄，與本專案自行設計的玩法和物理規則分開說明。
