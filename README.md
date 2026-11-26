# Northgo 網站地圖

課堂作業：分析 Northgo 官方網站，整理成可搜尋、響應式 HTML 網站地圖。

- 入口檔：`index.html`（可直接部署到 GitHub Pages 根目錄）
- 版本：`1.2.4`
- 網站內容核對日：2026-11-18
- 來源：<https://www.northgo.com/>
- `freight-logistics.html`：新增貨運物流專頁，包含響應式港口主視覺、海運／空運／陸運／報關、合作流程與出貨準備清單。
- `/news` 在核對時回傳 404，網站地圖保留此發現並標示提醒。
- Contact 頁同時包含詢價表單與七個全球辦公室據點。
- 服務子項目是各服務主頁內的內容區塊，不另列成獨立網址。

## GitHub Pages

將本資料夾中的 `index.html` 推到 GitHub repository 的根目錄，並在 repository 的 Settings → Pages 選擇從 `main` 分支的根目錄發布。推送／合併到 `main` 後，GitHub 會自動跑 `pages-build-deployment`，公開站：https://ymonsterb-hash.github.io/northgo-site-map/

頁尾可見版本：`index.html` footer 的 `<span class="version">版本 vX.Y.Z</span>`（貨運專頁 footer 亦顯示 `vX.Y.Z`）。來源檔：`VERSION`。

## 後續更新流程（bump, push and deploy）

1. 先用自然語言描述要修改的內容並完成更新、確認結果。
2. 再說 `bump, push and deploy`。代理（或本機）執行：

```bash
./scripts/bump-push-deploy.sh
```

腳本會：把 `VERSION` 的 patch +1、同步 `index.html`／`freight-logistics.html`／`README.md` 的版本字串、commit、push 目前分支。合併到 `main`（或直接 push `main`）即部署 GitHub Pages。

選項：`minor`／`major`、`--dry-run`、`--no-push`。執行前需設定好 `origin` remote 與 GitHub 登入。

## 客戶詢問與多人後台（v1.2.4）

前台貨運物流頁（`freight-logistics.html`）的詢問表單會送到 API；後台 `admin.html` 可：

- **客戶詢問 CRUD**（查看／新增／編輯／刪除、狀態更新）
- **帳號管理 CRUD**（多人登入；角色 `owner` / `editor`）

### 登入

- 管理後台（GitHub Pages）：https://ymonsterb-hash.github.io/northgo-site-map/admin.html
- API base：見 `api-config.js`（功課路徑指向 Cloudflare Worker）
- 首次部署時，Worker secrets 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 會自動建立第一位 **owner**；之後可在「帳號管理」新增其他成員。

### 資料怎麼存（功課路徑）

**GitHub Pages（前端）+ Cloudflare Worker + D1（後端／資料庫）**

1. 程式已在 GitHub：`ymonsterb-hash/northgo-site-map`
2. 在本機專案根目錄部署 Worker／D1（需 Node + Cloudflare 帳號）：

```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply northgo-inquiries --remote
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ALLOWED_ORIGIN
npx wrangler deploy
```

`ALLOWED_ORIGIN` 請設為 `https://ymonsterb-hash.github.io`。

3. 部署成功後 Worker 例：`https://northgo-inquiry-crud.<account>.workers.dev`  
4. Pages 上的 `admin.html`／`api-config.js` 需指向該 Worker；合併到 `main` 後 GitHub Pages 會自動更新。

可選備援：Cursor publish-app + Postgres（`server.mjs`）仍可運作，但**課堂繳交以 Cloudflare D1 為準**。

### 本機啟動

```bash
npm install
ADMIN_USERNAME=… ADMIN_PASSWORD=… SESSION_SECRET=… ALLOWED_ORIGINS=http://127.0.0.1:8787,http://localhost:8787 npm start
# 開 http://127.0.0.1:8787/admin.html 與 freight-logistics.html
```
