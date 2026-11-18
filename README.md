# Northgo 網站地圖

課堂作業：分析 Northgo 官方網站，整理成可搜尋、響應式 HTML 網站地圖。

- 入口檔：`index.html`（可直接部署到 GitHub Pages 根目錄）
- 版本：`1.1.1`
- 網站內容核對日：2026-11-18
- 來源：<https://www.northgo.com/>
- `/news` 在核對時回傳 404，網站地圖保留此發現並標示提醒。
- Contact 頁同時包含詢價表單與七個全球辦公室據點。
- 服務子項目是各服務主頁內的內容區塊，不另列成獨立網址。

## GitHub Pages

將本資料夾中的 `index.html` 推到 GitHub repository 的根目錄，並在 repository 的 Settings → Pages 選擇從 `main` 分支的根目錄發布。
## 後續更新流程

先用自然語言描述要修改的內容並完成更新；確認後輸入 `bump, push and deploy`，將版本號加一個 patch、提交 Git 變更、推送至 GitHub，並部署 GitHub Pages。執行前需先設定自己的 repository remote 與 GitHub 登入。