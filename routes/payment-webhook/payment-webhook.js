var express = require("express");
var router = express.Router();
let Razorpay = require("razorpay");
var crypto = require("crypto");
const moment = require("moment");
const Config = require("../../config/config.json")[process.env.NODE_ENV];
const db = require("../../models");
const { sendRegistrationMessage, getPaymentTemplatedMessageInput, sendMessage, transactionMessage } = require("../../utils/messageHelper");
const { appointmentMessage } = require("../../utils/messages");
const nodeMailer = require("nodemailer");
const transporter = nodeMailer.createTransport({
	service: "Gmail",
	auth: {
		user: Config.nodemailer.auth.user,
		pass: Config.nodemailer.auth.pass,
	},
});
router.post("/create-payment", async function (req, res, next) {
	try {
		let { userId, fullName, price, email, phone, selectedDoctor } = req.body;

		var instance = new Razorpay({
			key_id: Config.Razorpay.key_id,
			key_secret: Config.Razorpay.key_secret,
		});
		let newPrice = Number(price) * 100;
		const { id } = await instance.orders.create({
			amount: Math.floor(newPrice),
			currency: "INR",
			receipt: "receipt#1",
			notes: {
				id: userId,
				name: fullName,
				email: email,
				mobile: phone,
				selectedDoctor: selectedDoctor,
			},
		});
		console.log(id);
		res.send(`${Config.serverUrl}/payment?id=${id}`);
	} catch (error) {
		console.log(error);
	}
});

router.post("/payment-callback1", async function (req, res, next) {
	try {
		const requestedBody = JSON.stringify(req.body);
		const receivedSignature = req.headers["x-razorpay-signature"];
		const expectedSignature = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(requestedBody).digest("hex");
		if (receivedSignature === expectedSignature) {
			const event = req.body.event;
			if (event === "order.paid") {
				const status = req.body.payload.order.entity.status;
				if (status === "paid") {
					const userinfo = req.body.payload.payment.notes;
					const data = req.body.payload.payment;
					const userId = data.entity.notes.id;
					const name = data.entity.notes.name;
					const email = data.entity.notes.email;
					const mobile = data.entity.notes.mobile;
					const selectedDoctor = data.entity.notes.selectedDoctor;
					const orderId = data.entity.order_id;
					const status = data.entity.status;
					const amount = data.entity.amount;
					const date = data.entity.created_at;
					const PaymentTransactionId = data.entity.id;

					await db.PaymentTransaction.create({
						payerUserId: userId,
						PaymentTransactionId,
						paymentDate: moment.utc(),
						payerName: name,
						payerEmail: email,
						payerMobile: mobile,
						paymentAmount: amount / 100,
						receiverUserId: selectedDoctor,
						orderId,
						paymentStatus: status,
					});

					await db.WhatsappUser.update({ useStat: "PAYMENT-DONE", paymentId: orderId }, { where: { phone: mobile, appointmentConfirmed: false } });

					const message = await transactionMessage(name, amount / 100, orderId);
					await sendRegistrationMessage(mobile, `${message}`);

					const userInfo = await db.WhatsappUser.findOne({
						where: { phone: mobile, appointmentConfirmed: false },
					});

					const prescription = await db.Prescription.create({
						patientId: userInfo.userId,
						doctorId: userInfo.selectedDoctor,
					});
					const doctorInfo = await db.User.findOne({
						where: { userId: userInfo.selectedDoctor },
					});

					const appointment = await db.Appointment.create({
						patientId: userInfo.userId,
						doctorId: userInfo.selectedDoctor,
						prescriptionId: prescription.prescriptionId,
						status: "RECEIVED",
					});
					await db.WhatsappUser.update(
						{
							userStat: "SEND-APPOINTMENT",
							appointmentConfirmed: true,
						},
						{
							where: {
								phone: mobile,
								appointmentConfirmed: false,
							},
						}
					);
					const formattedDate = moment(userInfo.appointmentDate).format("DD-MM-YYYY");
					const meetFormattedDate = moment(userInfo.appointmentDate).format("YYYY-MM-DD");
					let data1;

					const time12Hour = userInfo.appointmentTime;
					const slotsStart = moment(time12Hour, "h:mm a").format("HH:mm");

					const slotsEnd = moment(slotsStart, "HH:mm").add(15, "minutes").format("HH:mm");

					try {
						const meetOptions = {
							clientId: Config.GoogleCred.clientId,
							refreshToken: `1//0gLXw_CJGs4qYCgYIARAAGBASNwF-L9Ir9RsJhDH2mKkYsuxE6o7Lpd44vLYlwTj9Gv6EDG5uxn7iw0GyxNkakPwfHUsC0yFI5g8`,
							date: meetFormattedDate,
							startTime: slotsStart,
							endTime: slotsEnd,
							clientSecret: Config.GoogleCred.googleClientSecret,
							summary: "KidsDoc-Online doctor consultation!",
							location: "Virtual venue",
							description: "Online consultation with your doctor",
							attendees: [{ email: doctorInfo.email }, { email: userInfo.email }],
							reminders: {
								useDefault: false,
								overrides: [
									{
										method: "email",
										minutes: 15,
									},
									{
										method: "email",
										minutes: 60,
									},
									{
										method: "popup",
										minutes: 10,
									},
								],
							},
							colorId: 4,
							sendUpdates: "all",
							status: "confirmed",
						};
						const result = await meet(meetOptions);
						console.log("🎉 Appointment scheduled successfully!");
						console.log("💼 A virtual appointment has been scheduled with your doctor.");
						console.log("🕒 Date:", meetFormattedDate);
						console.log("⏰ Time:", slotsStart, "-", slotsEnd);
						console.log("📌 Location: Virtual venue");
						console.log("📅 You will receive email reminders before the appointment.");

						if (result.status == "success" || result.status == "confirmed" || result.status == "Confirmed") {
							data1 = appointmentMessage(userInfo.fullName, formattedDate, userInfo.appointmentTime, result.link);
						} else {
							data1 = appointmentMessage(userInfo.fullName, formattedDate, userInfo.appointmentTime, "FAILED CASE LINK");
						}
						await sendRegistrationMessage(mobile, data1);
						await sendRegistrationMessage(`91` + doctorInfo.phone, `Hello Doctor, You have new appointment at ${meetFormattedDate} from ${slotsStart} - to ${slotsEnd} with ${userInfo.fullName}, Link to join ${result.link}`);
						const mailOptions = {
							from: Config.nodemailer.auth.user,
							to: [userInfo.email, doctorInfo.email],
							subject: "Online Consultation Booked",
							text: `Hello, You have appointment at ${meetFormattedDate} from ${slotsStart} - to ${slotsEnd} with ${userInfo.fullName}. Link to join ${result.link}`,
						};

						await transporter.sendMail(mailOptions);
						/**
						 * SEND A MESSAGE TO DOCTOR AS WELL
						 */
						res.status(200).send("RECEIVED");
					} catch (error) {
						console.error("❌ Appointment scheduling failed:", error);
					}
				}
			} else if (event === "payment.captured") {
				res.status(200).send("received");
			}
		} else {
			res.status(501).send("received but unverified resp");
		}
	} catch (error) {
		console.log(error);
	}
});

router.get("/", async function (req, res, next) {
	const { id } = req.query;
	if (id) {
		res.render("payment", { orderId: id });
	} else {
		res.render("payment-error");
	}
});

const { google } = require("googleapis");

// Set up OAuth 2.0 client
const oauth2Client = new google.auth.OAuth2(Config.GoogleCred.clientId, Config.GoogleCred.googleClientSecret, Config.GoogleCred.callBackURL);

router.get("/oauth2callback", async (req, res) => {
	const authUrl = oauth2Client.generateAuthUrl({
		access_type: "offline",
		scope: "https://www.googleapis.com/auth/calendar.events",
	});
	res.redirect(authUrl);
});

router.get("/google-redirect", async (req, res) => {
	const { tokens } = await oauth2Client.getToken(req.query.code);
	console.log("---------------------------------GOOGLE TOKEN------------------------------------------");
	console.log(tokens);
	oauth2Client.setCredentials(tokens);

	let result = await meet({
		clientId: Config.GoogleCred.clientId,
		refreshToken: `1//0gLXw_CJGs4qYCgYIARAAGBASNwF-L9Ir9RsJhDH2mKkYsuxE6o7Lpd44vLYlwTj9Gv6EDG5uxn7iw0GyxNkakPwfHUsC0yFI5g8`,
		date: "2023-08-21",
		startTime: "19:30",
		endTime: "22:00",
		clientSecret: Config.GoogleCred.googleClientSecret,
		summary: "KidsDoc-Online doctor consultation!",
		location: "Virtual venue",
		description: "Online consultation with your doctor",
		attendees: [{ email: "vinaydanidhariya4114@gmail.com" }, { email: "vinaydanidhariya04114@gmail.com" }],
		alert: 1,
		reminders: {
			useDefault: false,
			overrides: [
				{
					method: "email",
					minutes: 15,
				},
				{
					method: "email",
					minutes: 60,
				},
				{
					method: "popup",
					minutes: 10,
				},
			],
		},
		colorId: 4,
		sendUpdates: "all",
		status: "confirmed",
	});
	console.log(result);
	return res.send();
});

async function meet(options) {
	const { google } = require("googleapis");
	const { OAuth2 } = google.auth;

	let oAuth2Client = new OAuth2(options.clientId, options.clientSecret);

	oAuth2Client.setCredentials({
		refresh_token: options.refreshToken,
	});

	// Create a new calender instance.
	let calendar = google.calendar({ version: "v3", auth: oAuth2Client });

	const event = {
		summary: options.summary,
		location: options.location,
		description: options.description,
		colorId: 1,
		conferenceData: {
			createRequest: {
				requestId: "zzz",
				conferenceSolutionKey: {
					type: "hangoutsMeet",
				},
			},
		},
		start: {
			dateTime: `${options.date}T${options.startTime}:00`,
			timeZone: "Asia/Kolkata",
		},
		end: {
			dateTime: `${options.date}T${options.endTime}:00`,
			timeZone: "Asia/Kolkata",
		},
		attendees: options.attendees,
	};

	let link = await calendar.events.insert({
		calendarId: "primary",
		conferenceDataVersion: "1",
		resource: event,
	});

	if (link && link.data && link.data.status && link.data.status == "confirmed") {
		return {
			link: link.data.hangoutLink,
			status: "success",
		};
	} else {
		return {
			link: "NA",
			status: "failed",
		};
	}
}
module.exports = router;
