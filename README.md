# Northgo 網站地圖

課堂作業：分析 Northgo 官方網站，整理成可搜尋、響應式 HTML 網站地圖。

- 入口檔：`index.html`（可直接部署到 GitHub Pages 根目錄）
- 版本：`1.2.1`
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

## 客戶詢問管理（v1.2.1）

前台貨運物流頁新增詢問表單；後端 Worker 與 D1 設定檔為 `worker.js`、`schema.sql`、`wrangler.jsonc`。管理介面：`admin.html`。部署前需在 Cloudflare 設定 D1 binding 與管理者 secrets，並將 `api-config.js` 及 `admin.html` 的 API base 設為自己的 Worker URL。
