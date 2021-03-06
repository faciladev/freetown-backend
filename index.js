const express = require("express"),
  app = express(),
  formidable = require("formidable"),
  path = require("path"),
  fs = require("fs"),
  throttle = require("express-throttle-bandwidth"),
  XLSX = require("xlsx");
var admin = require("firebase-admin");
var serviceAccount = require("./service-account-file.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const currYear = new Date().getFullYear().toString().substring(2, 4);

function getSetting(businessId) {
  return new Promise((resolve, reject) => {
    admin
      .app()
      .firestore()
      .collectionGroup("settings")
      .where("businessId", "==", businessId)
      .get()
      .then((res) => {
        res.docs.forEach((doc) => {
          resolve(doc.data());
        });
      })
      .catch((e) => {
        reject(e);
      });
  });
}

function disqualifyTransaction(businessId, trans) {
  return new Promise((resolve, reject) => {
    const transRef = admin
      .app()
      .firestore()
      .doc(`businesses/${businessId}/transactions/${trans.id}`);
    transRef
      .update({ ...trans, status: "not-eligible" })
      .then((res) => {
        resolve();
      })
      .catch((e) => {
        reject(e);
      });
  });
}

function calculateReward(transTime, transAmt, setting) {
  if (parseInt(transAmt) > parseInt(setting.amount.max)) {
    transAmt = parseInt(setting.amount.max);
  }
  // const timePart = parseInt(transTime.match(/(\d{1,2})(?=\:)/)[0]);
  const timePart = transTime.toDate().getHours();
  let rewardAmt;
  //If transTime is morning
  if (
    timePart >= setting.time.morningStart &&
    timePart <= setting.time.morningEnd
  ) {
    //Apply setting morning %
    rewardAmt = parseInt(
      parseInt(transAmt) * parseFloat(setting.percent.morning / 100)
    );
  } else if (
    timePart >= setting.time.afternoonStart &&
    timePart <= setting.time.afternoonEnd
  ) {
    //If transTime is afternoon
    //Apply setting afternoon %
    rewardAmt = parseInt(
      parseInt(transAmt) * parseFloat(setting.percent.afternoon / 100)
    );
  } else if (
    timePart >= setting.time.nightStart &&
    timePart <= setting.time.nightEnd
  ) {
    //If transTime is night
    //Apply setting night %
    rewardAmt = parseInt(
      parseInt(transAmt) * parseFloat(setting.percent.night / 100)
    );
  } else {
    rewardAmt = 0;
  }

  return rewardAmt;
}

async function commissionTransaction(businessId, trans, setting) {
  return new Promise((resolve, reject) => {
    admin
      .app()
      .firestore()
      .runTransaction(async (transaction) => {
        const businessRef = admin
          .app()
          .firestore()
          .doc(`businesses/${businessId}`);
        const transRef = admin
          .app()
          .firestore()
          .doc(`businesses/${businessId}/transactions/${trans.id}`);

        const logRef = admin
          .app()
          .firestore()
          .collection(`businesses/${businessId}/logs`)
          .doc();
        const businessesDoc = await transaction.get(businessRef);
        const transDoc = await transaction.get(transRef);
        if (businessesDoc.exists) {
          const business = businessesDoc.data();
          //7% of amount is collected to bank
          const commissionAmt = parseInt(parseInt(trans.amount) * 0.07);
          //3% of amount is owed to advertiser
          // const advertiserCommission = parseInt(parseInt(trans.amount) * 0.03);
          if (business.bank) {
            transaction.update(businessRef, {
              bank: business.bank + commissionAmt,
              // advertiserCommission:
              //   business.advertiserCommission + advertiserCommission,
            });
          } else {
            transaction.update(businessRef, {
              bank: commissionAmt,
              // advertiserCommission,
            });
          }
        }
        if (transDoc.exists) {
          const rewardAmt = calculateReward(trans.time, trans.amount, setting);
          trans["rewardAmt"] = rewardAmt;
          transaction.update(transRef, {
            ...trans,
            status: "commissioned",
          });
          //Add Log
          const logTime = new Date();
          const logDate = new Date(logTime);
          logDate.setHours(0, 0, 0, 0);
          const transWithNoId = Object.assign({}, trans);
          delete transWithNoId.id;
          transaction.set(logRef, {
            ...transWithNoId,
            status: "commissioned",
            logTime: admin.firestore.Timestamp.fromDate(logTime),
            logDate: admin.firestore.Timestamp.fromDate(logDate),
          });
        }
        resolve();
      });
  });
}

function getRegisteredTransactions(businessId) {
  const transactions = [];
  return new Promise((resolve, reject) => {
    admin
      .app()
      .firestore()
      .collectionGroup("transactions")
      .where("businessId", "==", businessId)
      .where("status", "==", "registered")
      .get()
      .then((res) => {
        res.docs.forEach((doc) => {
          transactions.push({ ...doc.data(), id: doc.id });
        });
        resolve(transactions);
      })
      .catch((e) => {
        reject(e);
      });
  });
}

const dataParser = {
  parsedData: [],
  tempData: {},
  currentlySeeking: "refNo",
  seekedItems: {
    refNo: /CS-\d{5,}-\d{2}/,
    amount: /\d+\.\d{2}/, //Didn't need to use this
    refTime: /\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(\:\d{2})*/,
  },
  parse(dataArr) {
    //Check if data is valid
    if (!dataArr || dataArr.length === 0) {
      return;
    }

    //Loop data and parse content
    dataArr.forEach((nestedArr) => {
      if (nestedArr && nestedArr.length > 0) {
        //Real data is stored in a second dimentional array
        nestedArr.forEach((data) => {
          //Check if data is either a string or a number
          if (data && (typeof data == "string" || typeof data == "number")) {
            //Check currentlySeeking state and match corresponding regExp
            if (this.currentlySeeking == "refNo") {
              if (typeof data == "string") {
                const match = data.match(this.seekedItems["refNo"]);
                if (match && match.length > 0) {
                  this.tempData["refNo"] = match[0];
                  this.currentlySeeking = "refTime";
                }
              }
            } else if (this.currentlySeeking == "refTime") {
              if (typeof data == "string") {
                const match = data.match(this.seekedItems["refTime"]);
                if (match && match.length > 0) {
                  this.tempData["refTime"] = match[0];
                  this.currentlySeeking = "";
                }
              }
            } else if (this.currentlySeeking == "amount") {
              if (
                typeof data == "string" &&
                typeof parseFloat(data.replace(/\,/g, "")) == "number"
              ) {
                this.tempData["amount"] = parseFloat(data.replace(/\,/g, ""));
                this.parsedData.push(this.tempData);
                this.tempData = {};
                this.currentlySeeking = "refNo";
              }
            } else {
              if (typeof data == "string") {
                const match = data.match(/Sub Total/);
                if (match && match.length > 0) {
                  this.currentlySeeking = "amount";
                }
              }
            }
          }
        });
      } else {
        // console.error("*** Empty First Dimentional Array ***");
      }
    });
    return this.parsedData;
  },
};

function loadData(file) {
  var wb = XLSX.readFile(file);
  /* generate array of arrays */
  data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    raw: false,
  });
  // //Add Log
  // const logTime = new Date();
  // const logDate = new Date(logTime);
  // logDate.setHours(0, 0, 0, 0);
  // console.log(logTime, admin.firestore.Timestamp.fromDate(logTime));
  // console.log(logDate, admin.firestore.Timestamp.fromDate(logDate));
  // console.log(
  //   new Date().setHours(0, 0, 0, 0),
  //   admin.firestore.Timestamp.fromDate(logDate)
  // );
  // console.log(logTime.getHours(), logDate.getHours());
  // console.log(logTime.getDate(), logDate.getDate());
  // return;
  const parsedData = dataParser.parse(data);
  return parsedData;
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
app.get("/", (req, res) => {
  res.send("Thanks");
});

app.post("/upload", (req, res) => {
  const form = new formidable.IncomingForm();

  form.uploadDir = folder;
  form.parse(req, (_, fields, files) => {
    // console.log("\n-----------");
    // console.log("Fields", fields);
    // console.log("businessId", fields.businessId);
    // console.log("Fields inside", Object.keys(fields));
    // console.log("Received:", Object.keys(files));
    // console.log();
    var keys = Object.keys(files),
      k = keys[0];
    const parsedData = loadData(files[k].path);
    const businessId = fields.businessId;
    getRegisteredTransactions(businessId)
      .then((transactions) => {
        //loop transactions
        transactions.map((transaction) => {
          //Verify transaction
          const found = parsedData.find((data) => {
            return data.refNo == `CS-${transaction.referenceNo}-${currYear}`;
          });
          if (found) {
            transaction.amount = found.amount;
            transaction.time = admin.firestore.Timestamp.fromDate(
              new Date(found.refTime)
            );
            transaction.status = "verified";
            transaction.rewardAmt = found.amount;

            //Check eligibility
            getSetting(businessId)
              .then((setting) => {
                if (transaction.amount >= setting.amount.min) {
                  //Eligible
                  //Hence Commission

                  //Update Business Bank
                  commissionTransaction(businessId, transaction, setting)
                    .then((res) => {
                      transaction.status = "commissioned";
                      return transaction;
                    })
                    .catch((e) => console.error(e));
                } else {
                  //Not Eligible
                  disqualifyTransaction(businessId, transaction)
                    .then((res) => {
                      return transaction;
                    })
                    .catch((e) => console.error(e));
                }
              })
              .catch((e) => console.error(e));
          }
        });
        res.send("Thank you");
      })
      .catch((e) => {
        console.error(e);
      });
  });
});

app.listen(port, () => {
  console.log("\nUpload server running on http://localhost:" + port);
});
