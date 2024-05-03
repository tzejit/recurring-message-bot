Telegram bot to set recurring reminder at https://t.me/recurringmsg_bot

Reminders are triggered daily by default at the specified time.

Usage: <time in 24h format> <message> <flags>
Example: `1907 message -w 1,2 -d 2,4 -m 2,12`

Flags:
-w: Sets the message to only be sent on specific days of the week, taking in 0-6 representing Sunday to Saturday
Usage: -w 0,1,2,3,4,5,6 
Example: -w 0,3 sends a message every Sunday and Wednesday

-d: Sets the message to only be sent on specific days of the month.
Usage: -d 12,23 
Example: -d 12,23 sends a message every 12th and 23rd of the month

-m: Sets the message to only be sent of specific months of the year.
Usage: -m 1,12 
Example: -m 1,12 sends a message every Jan and Dec

Using multiple flags will require all flags to be fulfilled in order for the message to be sent. In the example above, this means the message will be sent at 19:07 on Mondays and Tuesdays that also happen to fall on the 2nd or 4th of Feburary or December

