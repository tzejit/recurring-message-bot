import { Db, Filter, MongoClient } from 'mongodb';

function argChecker(argString: string, errorMessage: string, lengthLimit: number, lowerBound: number, upperBound: number, key: string) {
  let numArr: number[] = argString.split(',').map(Number);
  if (numArr.length > lengthLimit) {
    return errorMessage
  }
  for (const element of numArr) {
    if (isNaN(element) || element > upperBound || element < lowerBound) {
      return errorMessage
    }
  }
  return { [key]: numArr }
}

const FLAGS = {
  'w': (str: string) => argChecker(str, "Invalid day\nUsage: -w 0,1,2,3,4,5,6 \nExample: -w 0,3 sends a message every Sunday and Wednesday", 7, 0, 6, 'day'),
  'd': (str: string) => argChecker(str, "Invalid date\nUsage: -d 12,23 \nExample: -d 12,23 sends a message every 12th and 23rd of the month", 31, 1, 31, 'date'),
  'm': (str: string) => argChecker(str, "Invalid month\nUsage: -m 1,12 \nExample: -m 1,12 sends a message every Jan and Dec", 12, 1, 12, 'month'),
}

const FLAGS_VERBOSE = { 'w': 'day', 'd': 'date', 'm': 'month' }

function getDbClient(uri: string) {
  return new MongoClient(uri, {
    maxPoolSize: 1, minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
  }).db("recurringMessageBot");
}

async function getUserData(client: Db, id: string) {
  return await client.collection('userCron').findOne({ "_id": id })
}

function getHHMM(time: string) {
  if (!time || time.length != 4) {
    return [-1, -1]
  }
  return [Number(time.slice(0, 2)), Number(time.slice(2))];
}

function getTimeString(hour: number, min: number) {
  return [`${hour < 10 ? '0' + hour : hour}`, `${min < 10 ? '0' + min : min}`]

}

function getParsedArgs(argsRaw: string[]) {
  let errorMessage: string[] = []
  let details = { time: '', message: '' }
  const [time, rest] = [argsRaw.shift(), argsRaw.join(' ')];
  const [hour, min] = getHHMM(time!)

  if (isNaN(Number(time)) || hour < 0 || hour > 23 || min < 0 || min > 59 || rest.length == 0) {
    errorMessage.push("Invalid argument\nUsage: <time in 24h format> <message>\nExample: 1907 dinner")
  }

  details.time = time!
  let splitArgs = rest.split('-')
  details.message = splitArgs.shift()!

  splitArgs.forEach(element => {
    if (!(element[0] in FLAGS)) {
      errorMessage.push(`Invalid flag -${element[0]}`)
    } else {
      let output = FLAGS[element[0]](element.slice(2))
      if (typeof output == 'string') {
        errorMessage.push(output)
      } else {
        details = { ...details, ...output };
      }
    }
  });
  return errorMessage.length != 0 ? errorMessage.join('\n\n') : details
}

function checkRecurringConditions(time: Date, argsDict: { [index: string]: number[] }, offset: number) {
  time.setHours(time.getHours() + offset);
  if ("day" in argsDict && !argsDict.day.includes(time.getDay())) {
    return false
  }
  if ("date" in argsDict && !argsDict.date.includes(time.getDate())) {
    return false
  }
  if ("month" in argsDict && !argsDict.month.includes(time.getMonth() + 1)) {
    return false
  }
  return true
}

export default {
  async fetch(request, env, ctx) {
    let client = getDbClient(env.MONGODB_URI)
    if (request.method === "POST") {
      const payload = await request.json()
      if ('message' in payload) {
        console.log(payload)
        const chatId = payload.message.chat.id
        let message = "Invalid command" //JSON.stringify(payload)
        try {
          if ('entities' in payload.message) {
            const command = payload.message.text.split(" ")[0]
            const argsRaw = payload.message.text.split(" ").slice(1)
            switch (command) {
              case "/help":
                {
                  message = "Sets a reminder triggered daily by default at the specified time.\n\n" +
                    "Usage: <time in 24h format> <message> <flags>\nExample: 1907 message -w 1,2 -d 2,4 -m 2,12\n\n" +
                    "Flags:\n" +
                    "-w: Sets the message to only be sent on specific days of the week, taking in 0-6 representing Sunday to Saturday\n" +
                    "Usage: -w 0,1,2,3,4,5,6 \nExample: -w 0,3 sends a message every Sunday and Wednesday\n\n" +
                    "-d: Sets the message to only be sent on specific days of the month.\n" +
                    "Usage: -d 12,23 \nExample: -d 12,23 sends a message every 12th and 23rd of the month\n\n" +
                    "-m: Sets the message to only be sent of specific months of the year.\n" +
                    "Usage: -m 1,12 \nExample: -m 1,12 sends a message every Jan and Dec\n\n" +
                    "Using multiple flags will require all flags to be fulfilled in order for the message to be sent. In the example above, this means the message will be sent at 19:07 on Mondays and Tuesdays that also happen to fall on the 2nd or 4th of Feburary or December"
                }
                break
              case "/set":
                {
                  const parsedArgs = getParsedArgs(argsRaw)
                  if (typeof parsedArgs === 'string') {
                    message = parsedArgs
                    break;
                  }

                  const [hour, min] = getHHMM(parsedArgs.time)

                  let userCronEntryResponse = await getUserData(client, chatId);

                  let userCronEntry = userCronEntryResponse;

                  if (!userCronEntry) {
                    userCronEntry = { "_id": chatId, "offset": 8, "jobs": [] };
                    parsedArgs['tz'] = 8
                    userCronEntry.jobs.push(parsedArgs);
                    message = "Message set";
                    await client.collection("userCron").insertOne(userCronEntry)
                  } else {
                    parsedArgs['tz'] = userCronEntry.offset
                    await client.collection("userCron").updateOne({
                      "_id": chatId
                    }, {
                      "$push": { "jobs": parsedArgs }
                    })
                    userCronEntry.jobs.push(parsedArgs);
                    message = "Message set";
                  }
                  let cronHour = (24 + hour - parsedArgs['tz']) % 24;
                  let [stringHour, stringMin] = getTimeString(cronHour, min);
                  await client.collection("cronTrigger").updateOne({
                    "_id": stringHour + stringMin
                  }, {
                    "$push": { [chatId]: parsedArgs }
                  }, { upsert: true })
                }
                break;

              case "/settimezone":
                {
                  const time = Number(argsRaw[0]);
                  if (isNaN(time) || time < -12 || time > 14 || !Number.isInteger(time)) {
                    message = "Invalid argument\nUsage: <integer timezone offset>\nExample: -10"
                    break;
                  }
                  await client.collection("userCron").updateOne({
                    "_id": chatId
                  }, {
                    "$set": { offset: time }
                  }, { upsert: true })

                  message = `Timezone set to ${time >= 0 ? "+" + time : time}\nDo note that previous reminders might not be accurate due to the change\nIt would be best to re-input all reminders again`
                }
                break;

              case "/view":
                {
                  let userCronEntryResponse = await getUserData(client, chatId);
                  let userCronEntry = userCronEntryResponse;

                  if (userCronEntry) {
                    message = "Reminders\n";
                    userCronEntry.jobs.forEach((entry, index) => {
                      let time = entry.time
                      let msg = entry.message
                      let tz = entry.tz
                      message += `(${index + 1}) Time: ${time.slice(0, 2)}:${time.slice(2)}, Message: ${msg}, Offset: ${tz}`
                      for (const [_, value] of Object.entries(FLAGS_VERBOSE)) {
                        if (value in entry)
                          message += `, ${value.charAt(0).toUpperCase() + value.slice(1)}: ${entry[value]}`
                      }
                      message += '\n\n'
                    })
                    message += `Default offset: ${userCronEntry.offset >= 0 ? "+" + userCronEntry.offset : userCronEntry.offset}`;
                  } else {
                    message = "No Reminders"
                  }
                }
                break;

              case "/remove":
                {
                  const index = Number(argsRaw[0]);
                  if (isNaN(index) || index < 1) {
                    message = "Invalid index selected"
                    break;
                  }

                  let userCronEntryResponse = await getUserData(client, chatId);
                  let userCronEntry = userCronEntryResponse;

                  if (index > userCronEntry.jobs.length) {
                    message = "Invalid index selected"
                    break;
                  }

                  let removedEntry = userCronEntry.jobs.splice(index - 1, 1)[0]
                  let userCronRemoveResponse = await client.collection("userCron").updateOne({
                    "_id": chatId
                  }, {
                    "$set": { "jobs": userCronEntry.jobs }
                  })
                  let userCronModifiedCount = userCronRemoveResponse.modifiedCount;

                  const [hour, min] = getHHMM(removedEntry.time)
                  const cronHour = (24 + hour - removedEntry.tz) % 24;
                  let [stringHour, stringMin] = getTimeString(cronHour, min);
                  let triggerCronRemoveResponse = await client.collection("cronTrigger").updateOne({
                    "_id": stringHour + stringMin
                  }, {
                    "$pull": { [chatId]: removedEntry }
                  });
                  let triggerCronModifiedCount = triggerCronRemoveResponse.modifiedCount;

                  if (userCronModifiedCount == 0 || triggerCronModifiedCount == 0) {
                    message = "No reminder was removed, check if the reminder time was inputted correctly";
                    break;
                  }

                  message = "Reminder sucessfully removed"
                }
                break;
              default:
                message = "Invalid command" //JSON.stringify(payload);
                break;
            }
          }
          const url = `https://api.telegram.org/bot${env.API_KEY}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`
          await fetch(url).then(resp => resp.json());
        } catch (error) {
          message = "Oops an error occured"
          const url = `https://api.telegram.org/bot${env.API_KEY}/sendMessage?chat_id=${chatId}&text=${message}`
          await fetch(url).then(resp => resp.json());
        }
      }

      return new Response(JSON.stringify(payload)) // Doesn't really matter
    }
    return new Response("OK") // Doesn't really matter
  },
  async scheduled(event, env, ctx) {
    const date = new Date(event.scheduledTime);
    const [hh, mm] = getTimeString(date.getHours(), date.getMinutes())
    const key = hh + mm
    let client = getDbClient(env.MONGODB_URI)
    let userCronTriggerResponse = await client.collection("cronTrigger").findOne({ "_id": key });
    let userCronSchedule: { [index: string]: { [index: string]: number[] | string } } = userCronTriggerResponse;
    if (!userCronSchedule) {
      return;
    }

    delete userCronSchedule._id;
    for (let [k, jobArr] of Object.entries(userCronSchedule)) {
      for (const v of jobArr) {
        if (checkRecurringConditions(new Date(event.scheduledTime), v, Number(v['tz']))) {
          const url = `https://api.telegram.org/bot${env.API_KEY}/sendMessage?chat_id=${k}&text=${encodeURIComponent(v.message)}`
          await fetch(url).then(resp => resp.json());
        }
      }
    }
  }
};