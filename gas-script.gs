var SPREADSHEET_ID = '1G35XhlQUZY1icDFNEX86qHRrFSzOJDdvZjZ-WXwIx8E';
var SHEET_NAME = 'ROOC定價記錄';

function doGet(e) {
  try {
    var action = e && e.parameter ? e.parameter.action : '';

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

    // 寫入報價記錄
    if (e && e.parameter && e.parameter.data) {
      var record = JSON.parse(e.parameter.data);
      var sheet = getOrCreateSheet();
      if (sheet.getLastRow() === 0) writeHeaders(sheet);
      sheet.appendRow(buildRow(record));
      return jsonResponse({ success: true });
    }

    // 讀取全部記錄（從可視欄位讀，手動修改過的欄位會生效）
    var sheet = getOrCreateSheet();
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return jsonResponse({ success: true, records: [] });
    var records = [];
    for (var i = 1; i < data.length; i++) {
      if (!data[i][0]) continue;
      try { records.push(rowToRecord(data[i])); } catch(e2) {}
    }
    return jsonResponse({ success: true, records: records });
  } catch(err) {
    return jsonResponse({ success: false, error: err.message });
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
    var raw = e.parameter.data || e.postData.contents;
    var record = JSON.parse(raw);
    var sheet = getOrCreateSheet();
    if (sheet.getLastRow() === 0) writeHeaders(sheet);
    sheet.appendRow(buildRow(record));
    return jsonResponse({ success: true });
  } catch(err) {
    return jsonResponse({ success: false, error: err.message });
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

function writeHeaders(sheet) {
  var headers = [
    'ID', '記錄時間', '類型', '商品名稱', '客人', '幣別', '匯率',
    '商品原價(原幣)', '商品原價(台幣)', '當地運費(台幣)',
    '貨運類別', '預估重量KG', '國際運費(台幣)', '國際關稅',
    '成本合計', '定價(台幣)', '淨利', '淨利率%',
    '合作對象', '零售定價', '代運費', '說明', '備註', '記錄者',
    '商品網址', '原幣售價', '親友價', 'raw_json'
  ];
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#7C3AED')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');

  // 固定欄寬
  var widths = [130,155,85,200,100,65,65,130,130,130,100,115,130,90,90,90,65,75,100,90,80,200,200,80,250,100,100,50];
  for (var i = 0; i < widths.length; i++) {
    sheet.setColumnWidth(i + 1, widths[i]);
  }
}

// 從可視欄位還原 record（讓手動修改的欄位在同步後生效）
function rowToRecord(row) {
  var typeRevMap = { '一般定價':'regular', '連線定價':'live', '合作開團':'partner', '代運計價':'forward' };
  var curRevMap  = { '韓幣':'KRW', '日幣':'JPY', '人民幣':'CNY', '港幣':'HKD', '台幣':'TWD' };
  var shipRevMap = { '韓國':'korea', '中國普貨':'china_normal', '中國特貨':'china_special', '日本':'japan', '香港':'hk' };

  var base = {};
  if (row[27]) { try { base = JSON.parse(row[27]); } catch(e) {} }

  var n = function(v, fb) { return (v !== '' && v != null) ? +v : (fb || 0); };
  var s = function(v, fb) { return (v !== '' && v != null && String(v) !== '') ? String(v) : (fb || ''); };

  return {
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
    JSON.stringify(r)
  ];
}

function setMasterPassword() {
  PropertiesService.getScriptProperties().setProperty('MASTER_PASSWORD', 'sj20130812');
  Logger.log('✅ 主控者密碼已設定完成');
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
