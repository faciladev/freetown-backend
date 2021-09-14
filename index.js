const express = require("express"),
  app = express(),
  formidable = require("formidable"),
  path = require("path"),
  fs = require("fs"),
  throttle = require("express-throttle-bandwidth"),
  XLSX = require("xlsx");

const dataParser = {
  parsedData: [],
  tempData: {},
  currentlySeeking: "referenceNo",
  seekedItems: {
    amount: /\d/,
    referenceNo: /\d/,
    referenceTime: /\d/,
  },
  seek: () => {},
};

function load_data(file) {
  var wb = XLSX.readFile(file);
  /* generate array of arrays */
  data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  console.log(data);
}

const port = process.env.PORT || 4444,
  folder = path.join(__dirname, "files");

if (!fs.existsSync(folder)) {
  fs.mkdirSync(folder);
}

app.set("port", port);
app.use(throttle(1024 * 128)); // throttling bandwidth

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

app.post("/upload", (req, res) => {
  const form = new formidable.IncomingForm();

  form.uploadDir = folder;
  form.parse(req, (_, fields, files) => {
    console.log("\n-----------");
    console.log("Fields", fields);
    console.log("Received:", Object.keys(files));
    console.log();
    var keys = Object.keys(files),
      k = keys[0];
    load_data(files[k].path);
    res.send("Thank you");
  });
});

app.listen(port, () => {
  console.log("\nUpload server running on http://localhost:" + port);
});
