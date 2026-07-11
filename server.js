const express = require('express');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const DB_URI = process.env.MONGODB_URI || 'mongodb+srv://sp8838780_db_user:rD2oI6WFTMHLs2vL@cluster0.y8vogab.mongodb.net/?appName=Cluster0';
const JWT_SECRET = process.env.JWT_SECRET || 'sweetpay-jwt-secret';
const ADMIN_KEY = process.env.ADMIN_KEY || 'sweetpay-admin-key';
const PORT = process.env.PORT || 3000;

const userSchema = new mongoose.Schema({
    mobile: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    referredBy: { type: String, default: null },
    myReferralCode: { type: String, unique: true, required: true },
    userID: { type: String, unique: true, required: true },
    status: { type: String, default: 'ON' },
    role: { type: String, default: 'USER' },
    isMaster: { type: Boolean, default: false },
    walletBalance: { type: Number, default: 0 },
    sellingLimit: { type: Number, default: 50000 },
    commission: { type: Number, default: 0 },
    totalRecharge: { type: Number, default: 0 },
    bankDetails: {
        accountNo: { type: String, default: null },
        ifsc: { type: String, default: null },
        bankName: { type: String, default: null },
        holderName: { type: String, default: null },
        bankStatus: { type: String, default: 'ON' }
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const paymentSchema = new mongoose.Schema({
    requestID: { type: String, unique: true, required: true },
    userID: { type: String, required: true },
    sellerID: { type: String, required: true },
    mobile: { type: String, required: true },
    amount: { type: Number, required: true },
    utr: { type: String, required: true, unique: true },
    proofImage: { type: String, required: true },
    status: { type: String, default: 'PENDING' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

let useFallbackStore = true;
const fallbackDir = path.join(__dirname, 'data');
const fallbackUsersFile = path.join(fallbackDir, 'users.json');
const fallbackPaymentsFile = path.join(fallbackDir, 'payments.json');

fs.mkdirSync(fallbackDir, { recursive: true });

function loadJson(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) return fallbackValue;
        const data = fs.readFileSync(filePath, 'utf8');
        return data ? JSON.parse(data) : fallbackValue;
    } catch (error) {
        return fallbackValue;
    }
}

function persistJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let usersData = loadJson(fallbackUsersFile, []);
let paymentsData = loadJson(fallbackPaymentsFile, []);

function getValueByPath(target, pathString) {
    return pathString.split('.').reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), target);
}

function matchQuery(item, query) {
    if (!query || Object.keys(query).length === 0) return true;
    if (query.$or) {
        return query.$or.some((condition) => matchQuery(item, condition));
    }

    return Object.entries(query).every(([key, expected]) => {
        const actual = getValueByPath(item, key);
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
            if (expected.$gte !== undefined) return actual >= expected.$gte;
            if (expected.$ne !== undefined) return actual !== expected.$ne;
            if (expected.$regex) {
                return new RegExp(expected.$regex, expected.$options || 'i').test(String(actual || ''));
            }
        }
        return actual === expected;
    });
}

function wrapDoc(doc, collectionName) {
    const instance = Object.assign({}, doc);
    instance.save = async function () {
        const collection = collectionName === 'User' ? usersData : paymentsData;
        const index = collection.findIndex((entry) => entry._id === instance._id || entry.userID === instance.userID || entry.requestID === instance.requestID || entry.mobile === instance.mobile);
        if (index >= 0) {
            collection[index] = { ...collection[index], ...instance };
        } else {
            if (!instance._id) instance._id = `${collectionName}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            collection.push({ ...instance });
        }
        if (collectionName === 'User') persistJson(fallbackUsersFile, usersData);
        else persistJson(fallbackPaymentsFile, paymentsData);
    };
    return instance;
}

function createFallbackQueryResult(items) {
    const result = items;
    result.sort = function (spec = {}) {
        const entries = Object.entries(spec || {});
        if (!entries.length) return this;
        const [field, direction] = entries[0];
        const multiplier = direction === -1 ? -1 : 1;
        Array.prototype.sort.call(this, (a, b) => {
            const valueA = a[field];
            const valueB = b[field];
            if (valueA instanceof Date || valueB instanceof Date) {
                const timeA = valueA instanceof Date ? valueA.getTime() : new Date(valueA).getTime();
                const timeB = valueB instanceof Date ? valueB.getTime() : new Date(valueB).getTime();
                return (timeA - timeB) * multiplier;
            }
            if (typeof valueA === 'number' || typeof valueB === 'number') {
                return (Number(valueA || 0) - Number(valueB || 0)) * multiplier;
            }
            return String(valueA || '').localeCompare(String(valueB || '')) * multiplier;
        });
        return this;
    };
    return result;
}

function createFallbackModel(collectionName) {
    const Model = function (data = {}) {
        return wrapDoc({ ...data, _id: data._id || `${collectionName}-${Date.now()}-${Math.random().toString(16).slice(2)}` }, collectionName);
    };

    Model.findOne = async function (query = {}) {
        const collection = collectionName === 'User' ? usersData : paymentsData;
        const found = collection.find((item) => matchQuery(item, query));
        return found ? wrapDoc(found, collectionName) : null;
    };

    Model.find = function (query = {}) {
        const collection = collectionName === 'User' ? usersData : paymentsData;
        return createFallbackQueryResult(collection.filter((item) => matchQuery(item, query)).map((item) => wrapDoc(item, collectionName)));
    };

    Model.findOneAndUpdate = async function (query = {}, update = {}) {
        const collection = collectionName === 'User' ? usersData : paymentsData;
        const index = collection.findIndex((item) => matchQuery(item, query));
        if (index < 0) return null;
        const current = collection[index];
        const updated = { ...current };
        if (update.$inc) {
            Object.entries(update.$inc).forEach(([key, amount]) => {
                updated[key] = Number(updated[key] || 0) + Number(amount || 0);
            });
        }
        if (update.$set) Object.assign(updated, update.$set);
        collection[index] = updated;
        if (collectionName === 'User') persistJson(fallbackUsersFile, usersData);
        else persistJson(fallbackPaymentsFile, paymentsData);
        return wrapDoc(updated, collectionName);
    };

    Model.countDocuments = async function (query = {}) {
        const collection = collectionName === 'User' ? usersData : paymentsData;
        return collection.filter((item) => matchQuery(item, query)).length;
    };

    return Model;
}

let User = createFallbackModel('User');
let Payment = createFallbackModel('Payment');

function switchToMongoModels() {
    if (!useFallbackStore) return;
    User = mongoose.model('User', userSchema);
    Payment = mongoose.model('Payment', paymentSchema);
    useFallbackStore = false;
}

async function ensureMasterAccount() {
    try {
        const existing = await User.findOne({ mobile: '9862713447' });
        if (existing) {
            if (existing.role !== 'ADMIN' || !existing.isMaster) {
                existing.role = 'ADMIN';
                existing.isMaster = true;
                existing.status = 'ON';
                existing.walletBalance = Number(existing.walletBalance || 500000);
                await existing.save();
            }
            return existing;
        }

        const masterSalt = crypto.randomBytes(16).toString('hex');
        const masterHash = hashPassword('Riya12340', masterSalt);
        const masterUser = new User({
            mobile: '9862713447',
            passwordHash: masterHash,
            passwordSalt: masterSalt,
            myReferralCode: 'REFMASTER01',
            userID: 'IDMASTER01',
            role: 'ADMIN',
            isMaster: true,
            walletBalance: 500000,
            sellingLimit: 1000000,
            commission: 0,
            totalRecharge: 0,
            bankDetails: {
                accountNo: '999999999999',
                ifsc: 'MASTER0001',
                bankName: 'SweetPay',
                holderName: 'Master Admin',
                bankStatus: 'ON'
            },
            status: 'ON'
        });

        await masterUser.save();
        return masterUser;
    } catch (error) {
        console.error('Master account bootstrap error:', error.message);
        return null;
    }
}

function generateUserID() {
    return 'ID' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateReferralCode() {
    return 'REF' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function verifyPassword(passwordHash, salt, password) {
    return hashPassword(password, salt) === passwordHash;
}

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(base64 + padding, 'base64').toString('utf8');
}

function createJwt(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${encodedHeader}.${encodedPayload}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJwt(token) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    if (expected !== signature) return null;
    try {
        return JSON.parse(base64UrlDecode(payload));
    } catch (error) {
        return null;
    }
}

function sanitizeUser(user) {
    if (!user) return null;
    return {
        userID: user.userID,
        mobile: user.mobile,
        myReferralCode: user.myReferralCode,
        referredBy: user.referredBy,
        walletBalance: Number(user.walletBalance || 0),
        commission: Number(user.commission || 0),
        totalRecharge: Number(user.totalRecharge || 0),
        sellingLimit: Number(user.sellingLimit || 50000),
        status: user.status,
        role: user.role || 'USER',
        isMaster: Boolean(user.isMaster),
        bankDetails: user.bankDetails || {},
        createdAt: user.createdAt
    };
}

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const payload = verifyJwt(token);
    if (!payload) {
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
    }
    req.user = payload;
    next();
}

async function creditReferralCommission(userID, amount) {
    const buyer = await User.findOne({ userID });
    if (!buyer || !buyer.referredBy) return;
    const referrer = await User.findOne({ myReferralCode: buyer.referredBy });
    if (!referrer) return;
    const commissionAmount = Number((amount * 0.04).toFixed(2));
    referrer.commission = Number((Number(referrer.commission || 0) + commissionAmount).toFixed(2));
    await referrer.save();
}

app.get('/health', (req, res) => res.json({ success: true, message: 'SweetPay API is healthy.' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/team', (req, res) => res.sendFile(path.join(__dirname, 'team.html')));
app.get('/regist', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/admin-panel', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.post('/api/register', async (req, res) => {
    try {
        const { mobile, pass, referral } = req.body;
        if (!mobile || !pass) {
            return res.status(400).json({ success: false, message: 'Mobile number and password are required.' });
        }
        if (!/^\d{10}$/.test(String(mobile))) {
            return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
        }
        if (String(pass).length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
        }

        const existingUser = await User.findOne({ mobile: String(mobile) });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'This mobile number is already registered.' });
        }

        let referralCode = referral && referral !== 'NONE' ? String(referral) : null;
        let referrer = null;
        if (referralCode) {
            referrer = await User.findOne({ myReferralCode: referralCode });
            if (!referrer) {
                referralCode = null;
            }
        }

        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = hashPassword(String(pass), salt);
        const newUser = new User({
            mobile: String(mobile),
            passwordHash,
            passwordSalt: salt,
            referredBy: referralCode,
            myReferralCode: generateReferralCode(),
            userID: generateUserID(),
            walletBalance: 10000,
            totalRecharge: 0,
            commission: 0
        });

        await newUser.save();
        const token = createJwt({ userID: newUser.userID, mobile: newUser.mobile });
        res.json({
            success: true,
            token,
            userID: newUser.userID,
            myReferralCode: newUser.myReferralCode,
            user: sanitizeUser(newUser),
            message: 'Registration successful.'
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error while creating account.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { mobile, pass } = req.body;
        const user = await User.findOne({ mobile: String(mobile) });
        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid mobile number or password.' });
        }
        const isValidPassword = verifyPassword(user.passwordHash, user.passwordSalt, String(pass));
        if (!isValidPassword) {
            return res.status(400).json({ success: false, message: 'Invalid mobile number or password.' });
        }
        if (user.status === 'OFF') {
            return res.status(403).json({ success: false, message: 'This account is suspended.' });
        }
        const token = createJwt({ userID: user.userID, mobile: user.mobile });
        res.json({ success: true, token, userID: user.userID, myReferralCode: user.myReferralCode, user: sanitizeUser(user), message: 'Login successful.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

app.get('/api/me', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ userID: req.user.userID });
        res.json({ success: true, user: sanitizeUser(user) });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Unable to fetch profile.' });
    }
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ userID: req.user.userID });
        res.json({ success: true, user: sanitizeUser(user) });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Unable to load dashboard.' });
    }
});

app.get('/api/p2p/match-account', requireAuth, async (req, res) => {
    try {
        const requestedAmount = parseInt(req.query.amount, 10);
        if (!requestedAmount || requestedAmount < 200) {
            return res.status(400).json({ success: false, message: 'Minimum transaction amount is ₹200.' });
        }

        const eligibleSeller = await User.findOne({
            status: 'ON',
            walletBalance: { $gte: requestedAmount },
            'bankDetails.bankStatus': 'ON',
            'bankDetails.accountNo': { $ne: null }
        });

        if (!eligibleSeller || (eligibleSeller.walletBalance - requestedAmount) < 200) {
            return res.status(404).json({ success: false, message: 'No active seller account is available for this amount right now.' });
        }

        res.json({
            success: true,
            sellerID: eligibleSeller.userID,
            bankDetails: {
                accountNo: eligibleSeller.bankDetails.accountNo,
                bankName: eligibleSeller.bankDetails.bankName,
                ifsc: eligibleSeller.bankDetails.ifsc,
                holderName: eligibleSeller.bankDetails.holderName
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Matching engine error.' });
    }
});

app.post('/api/submit-deposit', requireAuth, async (req, res) => {
    try {
        const amount = parseInt(req.body.amount, 10);
        const sellerID = req.body.sellerID || null;
        const utr = req.body.utr || `UTR${Date.now()}`;
        const proofImage = req.body.proofImage || 'upload-pending';
        if (!amount || amount < 200) {
            return res.status(400).json({ success: false, message: 'Minimum deposit amount is ₹200.' });
        }

        let matchedSeller = sellerID;
        if (!matchedSeller) {
            const seller = await User.findOne({
                status: 'ON',
                walletBalance: { $gte: amount },
                'bankDetails.bankStatus': 'ON',
                'bankDetails.accountNo': { $ne: null }
            });
            matchedSeller = seller ? seller.userID : 'AUTO';
        }

        const requestID = 'REQ' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const payment = new Payment({
            requestID,
            userID: req.user.userID,
            sellerID: matchedSeller,
            mobile: req.user.mobile,
            amount,
            utr,
            proofImage
        });
        await payment.save();
        res.json({ success: true, requestID, message: 'Deposit request submitted successfully. Please wait for verification.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Unable to submit deposit request.' });
    }
});

app.get('/api/my-payments', requireAuth, async (req, res) => {
    try {
        const payments = await Payment.find({ userID: req.user.userID }).sort({ createdAt: -1 });
        res.json({ success: true, payments });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Unable to load payment history.' });
    }
});

app.get('/api/token-history', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ userID: req.user.userID });
        const payments = await Payment.find({ userID: req.user.userID }).sort({ createdAt: -1 });
        const history = payments.map((payment) => ({
            type: payment.status === 'APPROVED' ? 'Recharge' : 'Pending',
            amount: payment.amount.toString(),
            utr: payment.utr,
            desc: `${payment.requestID} ${payment.status}`,
            time: payment.createdAt.toISOString()
        }));
        const commissionEntry = {
            type: 'Commission',
            amount: Number(user.commission || 0).toFixed(2),
            utr: `COMM-${user.userID}`,
            desc: 'Referral commission earned',
            time: new Date().toISOString()
        };
        res.json({ success: true, history: [commissionEntry, ...history] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Unable to load token history.' });
    }
});

app.get('/api/team-details', requireAuth, async (req, res) => {
    try {
        const refCode = req.query.refCode || req.user.myReferralCode;
        const members = await User.find({ referredBy: refCode });
        const totalCommission = members.reduce((sum, member) => sum + Number(member.commission || 0), 0);
        const teamRecharge = members.reduce((sum, member) => sum + Number(member.totalRecharge || 0), 0);
        res.json({
            success: true,
            teamMembers: members.map((member) => ({
                userID: member.userID,
                rechargeAmount: Number(member.totalRecharge || 0),
                commissionEarned: Number(member.commission || 0)
            })),
            totalCommission,
            teamRecharge,
            totalMembers: members.length
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Unable to load team details.' });
    }
});

app.post('/api/bank', requireAuth, async (req, res) => {
    try {
        const { accountNo, ifsc, bankName, holderName } = req.body;
        if (!accountNo || !ifsc || !bankName || !holderName) {
            return res.status(400).json({ success: false, message: 'All bank details are required.' });
        }
        const user = await User.findOne({ userID: req.user.userID });
        user.bankDetails = {
            accountNo: String(accountNo),
            ifsc: String(ifsc),
            bankName: String(bankName),
            holderName: String(holderName),
            bankStatus: 'ON'
        };
        await user.save();
        res.json({ success: true, user: sanitizeUser(user), message: 'Bank details saved.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Unable to save bank details.' });
    }
});

app.get('/api/bank', requireAuth, async (req, res) => {
    try {
        const user = await User.findOne({ userID: req.user.userID });
        res.json({ success: true, bankDetails: user.bankDetails });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Unable to load bank details.' });
    }
});

app.get('/api/admin/dashboard-data', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'] || req.query.adminKey || '';
        if (adminKey !== ADMIN_KEY) {
            return res.status(401).json({ success: false, message: 'Unauthorized admin access.' });
        }
        const search = req.query.search || '';
        let userQuery = {};
        let paymentQuery = {};
        if (search) {
            userQuery = {
                $or: [
                    { userID: { $regex: search, $options: 'i' } },
                    { mobile: { $regex: search, $options: 'i' } },
                    { 'bankDetails.accountNo': { $regex: search, $options: 'i' } }
                ]
            };
            paymentQuery = {
                $or: [
                    { utr: { $regex: search, $options: 'i' } },
                    { userID: { $regex: search, $options: 'i' } },
                    { requestID: { $regex: search, $options: 'i' } }
                ]
            };
        }
        const users = await User.find(userQuery);
        const payments = await Payment.find(paymentQuery).sort({ createdAt: -1 });
        const totalUsers = await User.countDocuments({});
        const pendingPayments = await Payment.countDocuments({ status: 'PENDING' });
        res.json({ success: true, users, payments, stats: { totalUsers, pendingPayments } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Unable to load admin dashboard.' });
    }
});

app.post('/api/admin/process-payment', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'] || req.body.adminKey || '';
        if (adminKey !== ADMIN_KEY) {
            return res.status(401).json({ success: false, message: 'Unauthorized admin access.' });
        }
        const { requestID, action } = req.body;
        const payRequest = await Payment.findOne({ requestID, status: 'PENDING' });
        if (!payRequest) {
            return res.status(404).json({ success: false, message: 'Request not found.' });
        }

        if (action === 'APPROVED') {
            const seller = await User.findOne({ userID: payRequest.sellerID });
            if (!seller || seller.walletBalance < payRequest.amount) {
                return res.status(400).json({ success: false, message: 'Seller balance is insufficient.' });
            }
            seller.walletBalance = Number((seller.walletBalance - payRequest.amount).toFixed(2));
            await seller.save();

            const buyer = await User.findOne({ userID: payRequest.userID });
            if (buyer) {
                buyer.walletBalance = Number((buyer.walletBalance + payRequest.amount).toFixed(2));
                buyer.totalRecharge = Number((buyer.totalRecharge + payRequest.amount).toFixed(2));
                await buyer.save();
                await creditReferralCommission(buyer.userID, payRequest.amount);
            }
            payRequest.status = 'APPROVED';
        } else {
            payRequest.status = 'CANCELLED';
        }

        payRequest.updatedAt = new Date();
        await payRequest.save();
        res.json({ success: true, message: 'Payment request updated successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Unable to process payment.' });
    }
});

mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => {
        console.log('MongoDB connected.');
        switchToMongoModels();
        app.listen(PORT, async () => {
            await ensureMasterAccount();
            console.log(`Server is running on http://localhost:${PORT}`);
        });
    })
    .catch((error) => {
        console.error('MongoDB connection failed:', error.message);
        useFallbackStore = true;
        User = createFallbackModel('User');
        Payment = createFallbackModel('Payment');
        app.listen(PORT, async () => {
            await ensureMasterAccount();
            console.log(`Server is running on http://localhost:${PORT} in fallback mode.`);
        });
    });