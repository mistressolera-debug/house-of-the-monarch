// House Bookings. An hour is written only after Throne confirms the deposit.
//
// 1. Paste this over the script that already serves the booking web app.
// 2. Put a private word in THRONE_KEY, then Deploy > Manage deployments >
//    pencil > New version > Deploy. Keep the same web app address.
// 3. In Throne, set the webhook to that address plus ?key= and the same word.

var THRONE_KEY = "";
var CALENDAR_NAME = "House Bookings";
var PENDING_MS = 6 * 60 * 60 * 1000;

function doPost(e) {
  e = e || {};
  var body = e.postData && e.postData.contents ? String(e.postData.contents) : "";
  var trimmed = body.replace(/^\s+/, "");
  if (trimmed.charAt(0) === "{") {
    return handleThrone_(body, e.parameter && e.parameter.key);
  }
  var params = e.parameter || {};
  if (!params.intent && body.indexOf("intent=") !== -1) params = parseForm_(body);
  return handleIntent_(params);
}

function doGet() {
  return html_("The desk is awake. An hour is written only after the deposit.");
}

function handleIntent_(params) {
  try {
    var row = readIntent_(params);
    var held = houseCalendar_().getEvents(row.start, row.end);
    if (held.length) return html_("That hour is already held.");
    PropertiesService.getScriptProperties().setProperty("desk:" + row.code, JSON.stringify({
      code: row.code,
      who: row.who,
      length: row.length,
      note: row.note,
      start: row.start.toISOString(),
      end: row.end.toISOString(),
      created: Date.now()
    }));
    return html_("The hour is not held. Put " + row.code + " in the Throne gift message.");
  } catch (err) {
    return html_(String(err && err.message ? err.message : err));
  }
}

function handleThrone_(body, key) {
  if (!THRONE_KEY || key !== THRONE_KEY) return html_("The desk did not recognize that call.");
  var payload = JSON.parse(body);
  var data = payload.data || {};
  var message = String(data.message || "").toUpperCase();
  var found = message.match(/DESK-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}/);
  if (!found) return html_("No desk code.");
  var code = found[0];
  var raw = PropertiesService.getScriptProperties().getProperty("desk:" + code);
  if (!raw) return html_("That code is not waiting.");
  var row = JSON.parse(raw);
  if (Date.now() - Number(row.created) > PENDING_MS) {
    PropertiesService.getScriptProperties().deleteProperty("desk:" + code);
    return html_("That code has expired.");
  }
  var cents = Number(data.amount != null ? data.amount : data.price);
  var need = row.length === "hour" ? 20000 : 10000;
  if (!(cents >= need)) return html_("The tribute is short of the deposit.");
  var start = new Date(row.start);
  var end = new Date(row.end);
  var cal = houseCalendar_();
  if (cal.getEvents(start, end).length) return html_("That hour was already held.");
  var event = cal.createEvent("Audience · " + row.who, start, end, {
    description: "Deposit received on Throne.\n" + row.code + (row.note ? "\n" + row.note : "")
  });
  event.removeAllReminders();
  [10080, 1440, 60, 30].forEach(function (minutes) {
    event.addPopupReminder(minutes);
  });
  event.setColor(CalendarApp.EventColor.PURPLE);
  PropertiesService.getScriptProperties().deleteProperty("desk:" + code);
  return html_("The hour is on House Bookings.");
}

function readIntent_(params) {
  var who = String(params.who || "").trim().slice(0, 40);
  var day = String(params.when_day || "");
  var time = String(params.when_time || "");
  var length = params.length === "half" ? "half" : "hour";
  var note = String(params.desk_note || "").trim().slice(0, 280);
  var code = String(params.desk_code || "").toUpperCase();
  if (!who || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("The desk needs a handle, a date, and a time.");
  }
  if (!/^DESK-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(code)) {
    throw new Error("The desk code is not valid.");
  }
  var parts = day.split("-");
  var clock = time.split(":");
  var hour = Number(clock[0]);
  var minute = Number(clock[1]);
  if (minute !== 0 && minute !== 30) throw new Error("The desk keeps the half hour.");
  var weekday = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
  if (weekday < 3 || weekday > 6) throw new Error("The desk is open Wednesday through Saturday.");
  var endMinute = hour * 60 + minute + (length === "hour" ? 60 : 30);
  if (hour < 18 || endMinute > 22 * 60) throw new Error("The desk is open from 6:00 to 10:00 pm Toronto.");
  var start = fromToronto_(Number(parts[0]), Number(parts[1]), Number(parts[2]), hour, minute);
  if (start.getTime() < Date.now() + 2 * 60 * 60 * 1000) {
    throw new Error("Book at least two hours ahead.");
  }
  return {
    who: who,
    length: length,
    note: note,
    code: code,
    start: start,
    end: new Date(start.getTime() + (length === "hour" ? 60 : 30) * 60 * 1000)
  };
}

function fromToronto_(year, month, day, hour, minute) {
  var guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  var seen = Utilities.formatDate(guess, "America/Toronto", "yyyy-MM-dd HH:mm").split(" ");
  var seenDay = seen[0].split("-");
  var seenClock = seen[1].split(":");
  var seenUtc = Date.UTC(Number(seenDay[0]), Number(seenDay[1]) - 1, Number(seenDay[2]), Number(seenClock[0]), Number(seenClock[1]));
  var wantUtc = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(guess.getTime() + (wantUtc - seenUtc));
}

function houseCalendar_() {
  var found = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  if (!found.length) throw new Error("House Bookings is not on this account.");
  return found[0];
}

function parseForm_(body) {
  var params = {};
  String(body).split("&").forEach(function (pair) {
    var bits = pair.split("=");
    if (!bits[0]) return;
    params[decodeURIComponent(bits[0].replace(/\+/g, " "))] = decodeURIComponent((bits[1] || "").replace(/\+/g, " "));
  });
  return params;
}

function html_(message) {
  return HtmlService.createHtmlOutput(
    '<p style="font-family:Georgia,serif;padding:2rem">' +
      String(message).replace(/[&<>]/g, function (ch) {
        return { "&": "&", "<": "<", ">": ">" }[ch];
      }) +
    '</p><p><a href="https://houseofthemonarch.com/">Return to the house</a></p>'
  );
}
