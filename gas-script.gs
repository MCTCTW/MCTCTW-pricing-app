var SPREADSHEET_ID = '1G35XhlQUZY1icDFNEX86qHRrFSzOJDdvZjZ-WXwIx8E';
var SHEET_NAME = 'ROOC定價記錄';
var DEL_SHEET = '刪除註記';
var VER = 'v2-upsert';   // 前端會檢查這個版本：不是這一版就不重試（舊版是無腦 appendRow，重試會生重複列）

function doGet(e) {
  try {
    var action = e && e.parameter ? e.parameter.action : '';

    if (action === 'ping') {
      return jsonResponse({ success: true, ping: true, version: VER, ts: new Date().toISOString() });
    }

    if (action === 'deleteRecord') {
      return jsonResponse(deleteRecord_(e.parameter.id, e.parameter.by));
    }

    if (action === 'verifyPassword') {
      var stored = PropertiesService.getScriptProperties().getProperty('MASTER_PASSWORD');
      var input  = e.parameter.pw || '';
      return jsonResponse({ success: true, verified: (stored && input === stored) });
    }

    if (action === 'saveSettings') {
      var settingsSheet = getOrCreateSettingsSheet();
      settingsSheet.getRange('A1').setValue(e.parameter.data);
      return jsonResponse({ success: true });
    }

    if (action === 'getSettings') {
      var settingsSheet = getOrCreateSettingsSheet();
      var val = settingsSheet.getRange('A1').getValue();
      return jsonResponse({ success: true, settings: val || '' });
    }

    // 精簡商品索引（給重量核算/記帳做品名自動補全用）
    // 伺服器端先去重＋只回必要欄位 → 傳輸量約為完整 records 的 1/10，手機弱網也抓得動
    if (action === 'productIndex') {
      return jsonResponse({ success: true, v: 1, items: buildProductIndex() });
    }

    // 寫入報價記錄（同一個 id 就覆蓋那一列，不再無腦 append 生重複列）
    if (e && e.parameter && e.parameter.data) {
      return jsonResponse(saveRecord_(JSON.parse(e.parameter.data)));
    }

    // 讀取全部記錄（從可視欄位讀，手動修改過的欄位會生效）
    var sheet = getOrCreateSheet();
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return jsonResponse({ success: true, records: [], dels: readDels_(), version: VER });
    var records = [];
    var bad = 0;
    for (var i = 1; i < data.length; i++) {
      if (!data[i][0]) continue;
      try { records.push(rowToRecord(data[i])); } catch(e2) { bad++; }
    }
    return jsonResponse({ success: true, records: records, dels: readDels_(), bad: bad, version: VER });
  } catch(err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ---------- 寫入：以 id upsert（重複列時更新最後一列，跟讀取的「後者覆蓋前者」一致） ----------
function saveRecord_(record) {
  if (!record || !record.id) return { success: false, fatal: true, error: '這筆沒有 id，無法寫入' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (_) { return { success: false, error: '後端忙碌中，稍後自動重試', version: VER }; }
  try {
    var sheet = getOrCreateSheet();
    ensureHeaders(sheet);
    var row = buildRow(record);
    var target = findRowById_(sheet, record.id);
    if (target > 0) sheet.getRange(target, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
    unDelete_(record.id);                       // 重新存同一個 id＝這筆又活了，把刪除註記清掉
    return { success: true, mode: target > 0 ? 'update' : 'append', version: VER };
  } catch (err) {
    return { success: false, error: err.message, version: VER };
  } finally {
    lock.releaseLock();
  }
}
function findRowById_(sheet, id) {
  if (!id) return -1;
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var col = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) {          // 由下往上：有重複列時以最後一列為準
    if (String(col[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

// ---------- 刪除：真的從表上移除，並留下註記（否則別台一同步就把它寫回來） ----------
function getDelSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(DEL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DEL_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['ID', '刪除時間', '操作者']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readDels_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(DEL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(function (r) { return String(r[0]); })
    .filter(function (x) { return x; });
}
function unDelete_(id) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(DEL_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  var col = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) {
    if (String(col[i][0]) === String(id)) sh.deleteRow(i + 2);
  }
}
function deleteRecord_(id, by) {
  if (!id) return { success: false, fatal: true, error: '沒有指定 id' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (_) { return { success: false, error: '後端忙碌中，稍後自動重試', version: VER }; }
  try {
    var sheet = getOrCreateSheet();
    var last = sheet.getLastRow();
    var removed = 0;
    if (last >= 2) {
      var col = sheet.getRange(2, 1, last - 1, 1).getValues();
      for (var i = col.length - 1; i >= 0; i--) {       // 由下往上刪，索引才不會位移
        if (String(col[i][0]) === String(id)) { sheet.deleteRow(i + 2); removed++; }
      }
    }
    getDelSheet_().appendRow([String(id), new Date(), by || '']);
    return { success: true, deleted: removed, version: VER };
  } catch (err) {
    return { success: false, error: err.message, version: VER };
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSettingsSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName('APP設定');
  if (!sheet) sheet = ss.insertSheet('APP設定');
  return sheet;
}

function doPost(e) {
  try {
    var raw = (e && e.parameter && e.parameter.data) || (e && e.postData && e.postData.contents) || '';
    var body = JSON.parse(raw);
    // 支援兩種：單筆紀錄，或 {records:[...]} 一次補傳多筆（前端離線佇列恢復時用）
    if (body && body.records && body.records.length) {
      var out = [];
      for (var i = 0; i < body.records.length; i++) out.push(saveRecord_(body.records[i]));
      var okAll = out.every(function (r) { return r.success; });
      return jsonResponse({ success: okAll, results: out, version: VER });
    }
    return jsonResponse(saveRecord_(body));
  } catch(err) {
    return jsonResponse({ success: false, error: err.message, version: VER });
  }
}

function getOrCreateSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    writeHeaders(sheet);
  }
  return sheet;
}

// 預期欄位（已有舊資料則自動於右側追加缺少的欄位，不會動到舊欄位順序）
var EXPECTED_HEADERS = [
  'ID', '記錄時間', '類型', '商品名稱', '客人', '幣別', '匯率',
  '商品原價(原幣)', '商品原價(台幣)', '當地運費(台幣)',
  '貨運類別', '預估重量KG', '國際運費(台幣)', '國際關稅',
  '成本合計', '定價(台幣)', '淨利', '淨利率%',
  '合作對象', '零售定價', '代運費', '說明', '備註', '記錄者',
  '商品網址', '原幣售價', '親友價', 'raw_json',
  '當地運費(原幣)' // 2026-05-06 新增
];

function writeHeaders(sheet) {
  sheet.appendRow(EXPECTED_HEADERS);
  sheet.getRange(1, 1, 1, EXPECTED_HEADERS.length)
    .setBackground('#7C3AED')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');

  // 固定欄寬
  var widths = [130,155,85,200,100,65,65,130,130,130,100,115,130,90,90,90,65,75,100,90,80,200,200,80,250,100,100,50,130];
  for (var i = 0; i < widths.length; i++) {
    sheet.setColumnWidth(i + 1, widths[i]);
  }
}

// 確保標題列包含所有預期欄位（缺的補在右邊）
function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) { writeHeaders(sheet); return; }
  var lastCol = sheet.getLastColumn();
  var current = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var i = current.length; i < EXPECTED_HEADERS.length; i++) {
    sheet.getRange(1, i + 1)
      .setValue(EXPECTED_HEADERS[i])
      .setBackground('#7C3AED')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
    sheet.setColumnWidth(i + 1, 130);
  }
}

// 從可視欄位還原 record（讓手動修改的欄位在同步後生效）
// 🚨 一定要「先把 raw_json 整包展開當底」再用可視欄位覆蓋：代運計價的實際運回日期／基礎運費／營業稅／
//    金流手續費、合作開團的成本／服務費／驗貨費／國際運費、親友價這些欄位在表上沒有欄，
//    以前直接回傳新物件 → 同步一次就把本機那些欄位清成 undefined 並寫死。
function rowToRecord(row) {
  var typeRevMap = { '一般定價':'regular', '連線定價':'live', '合作開團':'partner', '代運計價':'forward' };
  var curRevMap  = { '韓幣':'KRW', '日幣':'JPY', '人民幣':'CNY', '港幣':'HKD', '台幣':'TWD' };
  var shipRevMap = { '韓國':'korea', '中國普貨':'china_normal', '中國特貨':'china_special', '日本':'japan', '香港':'hk' };

  var base = {};
  if (row[27]) { try { base = JSON.parse(row[27]); } catch(e) {} }

  var n = function(v, fb) { return (v !== '' && v != null) ? +v : (fb || 0); };
  var s = function(v, fb) { return (v !== '' && v != null && String(v) !== '') ? String(v) : (fb || ''); };

  var out = {};
  for (var k in base) out[k] = base[k];        // 先繼承 raw_json 的完整內容
  var vis = {
    id:            s(row[0], base.id),
    timestamp:     base.timestamp || '',
    type:          typeRevMap[row[2]] || base.type || '',
    product:       s(row[3], base.product),
    customer:      s(row[4], base.customer),
    currency:      curRevMap[row[5]] || base.currency || '',
    rate:          n(row[6], base.rate),
    originalPrice: n(row[7], base.originalPrice),
    productTWD:    n(row[8], base.productTWD),
    localShipTWD:  n(row[9], base.localShipTWD),
    localShipOriginal: n(row[28], base.localShipOriginal), // 新欄位，舊資料 fallback 到 raw_json
    shippingType:  shipRevMap[row[10]] || base.shippingType || '',
    weight:        n(row[11], base.weight),
    intlShipTWD:   n(row[12], base.intlShipTWD),
    tariff:        n(row[13], base.tariff),
    totalCost:     n(row[14], base.totalCost),
    finalPrice:    n(row[15], base.finalPrice),
    netProfit:     n(row[16], base.netProfit),
    marginPct:     n(row[17], base.marginPct),
    partnerName:   s(row[18], base.partnerName),
    retailPrice:   n(row[19], base.retailPrice),
    description:   s(row[21], base.description),
    notes:         s(row[22], base.notes),
    savedBy:       s(row[23], base.savedBy),
    url:           s(row[24], base.url)
  };
  for (var k2 in vis) out[k2] = vis[k2];        // 可視欄位覆蓋（會計手動改過的會生效）
  if (!out.timestamp && row[1]) { try { out.timestamp = new Date(row[1]).toISOString(); } catch (e3) {} }
  return out;
}

function buildRow(r) {
  var typeMap = { regular:'一般定價', live:'連線定價', partner:'合作開團', forward:'代運計價' };
  var shipMap = { korea:'韓國', china_normal:'中國普貨', china_special:'中國特貨', japan:'日本', hk:'香港' };
  var curMap  = { KRW:'韓幣', JPY:'日幣', CNY:'人民幣', HKD:'港幣', TWD:'台幣' };

  // 原幣售價：建議定價換回外幣（例如韓幣）
  var foreignPrice = '';
  if (r.rate && r.currency && r.currency !== 'TWD' && r.finalPrice) {
    foreignPrice = Math.round(r.finalPrice / r.rate);
  }
  // 親友價：建議定價 - 營業稅 - 金流手續費 = 成本合計 + 淨利
  var friendPrice = '';
  if ((r.type === 'regular' || r.type === 'live') && r.finalPrice) {
    friendPrice = (r.totalCost || 0) + (r.netProfit || 0);
  }

  return [
    r.id || '',
    r.timestamp ? new Date(r.timestamp).toLocaleString('zh-TW') : '',
    typeMap[r.type] || r.type || '',
    r.product || r.description || '',
    r.customer || '',
    curMap[r.currency] || '',
    r.rate || '',
    r.originalPrice || '',
    r.productTWD || '',
    r.localShipTWD || '',
    shipMap[r.shippingType] || '',
    r.weight || '',
    r.intlShipTWD || '',
    r.tariff || '',
    r.totalCost || '',
    r.finalPrice || '',
    r.netProfit || '',
    r.marginPct || '',
    r.partnerName || '',
    r.retailPrice || '',
    r.type === 'forward' ? r.finalPrice : '',
    r.description || '',
    r.notes || '',
    r.savedBy || '',
    r.url || '',
    foreignPrice,
    friendPrice,
    JSON.stringify(r),
    r.localShipOriginal || ''  // 當地運費(原幣)
  ];
}

// ---------- 一次性維護：清掉重複 id 的舊列（保留最後一列＝最新版本） ----------
// 用法：Apps Script 編輯器選這個函數 → 執行。會先複製一份備份分頁再刪，安全。
function dedupeRecords() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = getOrCreateSheet();
  var last = sheet.getLastRow();
  if (last < 3) return '沒有資料需要處理';
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  var seen = {}, kill = [];
  for (var i = ids.length - 1; i >= 0; i--) {          // 由下往上：先看到的是最新的，保留
    var id = String(ids[i][0]);
    if (!id) continue;
    if (seen[id]) kill.push(i + 2); else seen[id] = 1;
  }
  if (!kill.length) return '沒有重複的 id';
  sheet.copyTo(ss).setName('備份_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd_HHmmss'));
  kill.sort(function (a, b) { return b - a; });
  for (var j = 0; j < kill.length; j++) sheet.deleteRow(kill[j]);
  var msg = '✅ 已刪掉 ' + kill.length + ' 列重複（保留每個 id 最後一列），刪除前已另存備份分頁';
  Logger.log(msg);
  return msg;
}

function setMasterPassword() {
  PropertiesService.getScriptProperties().setProperty('MASTER_PASSWORD', 'sj20130812');
  Logger.log('✅ 主控者密碼已設定完成');
}

// 一鍵補齊試算表標題列（新增「當地運費(原幣)」等缺少的欄位）
// 用法：Apps Script 編輯器選此函數 → 點「執行」
function runMigration() {
  var sheet = getOrCreateSheet();
  var beforeCols = sheet.getLastColumn();
  ensureHeaders(sheet);
  var afterCols = sheet.getLastColumn();
  var msg = '✅ 標題列檢查完成：' + beforeCols + ' 欄 → ' + afterCols + ' 欄';
  if (afterCols > beforeCols) {
    msg += '（已新增 ' + (afterCols - beforeCols) + ' 個欄位）';
  } else {
    msg += '（無需新增）';
  }
  Logger.log(msg);
  return msg;
}

// 一次性修正：直接把「當地運費(原幣)」寫到 AC1（欄 29）
function fixHeaderManual() {
  var sheet = getOrCreateSheet();
  sheet.getRange(1, 29)
    .setValue('當地運費(原幣)')
    .setBackground('#7C3AED')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');
  sheet.setColumnWidth(29, 130);
  Logger.log('✅ 已將「當地運費(原幣)」寫入 AC1（欄 29）');
}

// 診斷：列出試算表所有工作表和標題列
function debugSheets() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Logger.log('📊 試算表 ID: ' + SPREADSHEET_ID);
  Logger.log('📊 試算表名稱: ' + ss.getName());
  Logger.log('📊 工作表清單:');
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i];
    var lastCol = s.getLastColumn();
    var lastRow = s.getLastRow();
    Logger.log('  ' + (i+1) + '. 「' + s.getName() + '」 — ' + lastCol + ' 欄 × ' + lastRow + ' 列');
    if (lastCol > 0 && lastRow > 0) {
      var headers = s.getRange(1, 1, 1, lastCol).getValues()[0];
      Logger.log('     標題: ' + JSON.stringify(headers));
    }
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 精簡商品索引：每個品名只留最新一筆，欄位用陣列（省掉重複的欄位名）。
 * 每筆 = [品名, 客人, 幣別, 原幣價, 貨運類別, 預估重KG, 國際運費TWD, 定價TWD, 類型]
 * 若最新那筆沒有重量（例如連線/合作定價），會沿用「最近一筆有重量的一般定價」的重量與運費，
 * 讓重量核算的預估重不會因為後來開了連線團就消失。
 */
function buildProductIndex() {
  var sheet = getOrCreateSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var typeRevMap = { '一般定價':'regular', '連線定價':'live', '合作開團':'partner', '代運計價':'forward' };
  var curRevMap  = { '韓幣':'KRW', '日幣':'JPY', '人民幣':'CNY', '港幣':'HKD', '台幣':'TWD' };
  var shipRevMap = { '韓國':'korea', '中國普貨':'china_normal', '中國特貨':'china_special', '日本':'japan', '香港':'hk' };
  var num = function(v) { return (v !== '' && v != null) ? (+v || 0) : 0; };

  var latest = {}, withWeight = {}, order = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0] || !row[3]) continue;                 // 沒 ID 或沒品名的列跳過
    var product = String(row[3]).trim();
    if (!product) continue;
    var key = product.toLowerCase();
    if (!latest.hasOwnProperty(key)) order.push(key);

    var type = typeRevMap[row[2]] || '';
    var rec = [
      product,
      row[4] ? String(row[4]) : '',                   // 客人
      curRevMap[row[5]] || '',                        // 幣別
      num(row[7]),                                    // 原幣價
      shipRevMap[row[10]] || '',                      // 貨運類別
      num(row[11]),                                   // 預估重量KG
      num(row[12]),                                   // 國際運費TWD
      num(row[15]),                                   // 定價TWD
      type
    ];
    latest[key] = rec;                                // 由上而下掃，越後面越新
    if (type === 'regular' && num(row[11]) > 0) withWeight[key] = rec;
  }

  var out = [];
  for (var j = 0; j < order.length; j++) {
    var k = order[j], r = latest[k], w = withWeight[k];
    if (w && !(r[5] > 0)) { r[4] = w[4]; r[5] = w[5]; r[6] = w[6]; }   // 借用最近一筆有重量的資料
    out.push(r);
  }
  return out;
}
