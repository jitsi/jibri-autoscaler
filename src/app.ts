import bodyParser from 'body-parser';
import config from './config';
import express from 'express';
import Handlers from './handlers';
import Redis from 'ioredis';
import logger from './logger';
import ASAPPubKeyFetcher from './asap';
import jwt from 'express-jwt';
import { JibriTracker } from './jibri_tracker';
import Autoscaler from './autoscaler';
import CloudManager from './cloud_manager';
import { InstanceStatus } from './instance_status';

//import { RequestTracker, RecorderRequestMeta } from './request_tracker';
//import * as meet from './meet_processor';

//const jwtSigningKey = fs.readFileSync(meet.TokenSigningKeyFile);

const app = express();
app.use(bodyParser.json());

// TODO: Add custom error handler for express that handles jwt 401/403
// TODO: Add prometheus stating middleware for each http
// TODO: Add http logging middleware
// TODO: metrics overview

// TODO: JWT Creation for Lua Module API
// TODO: JWT Creation for requestor

// TODO: unittesting
// TODO: doc strings???
// TODO: readme updates and docker compose allthethings

app.get('/health', (req: express.Request, res: express.Response) => {
    res.send('healthy!');
});

const redisClient = new Redis({
    host: config.RedisHost,
    port: Number(config.RedisPort),
    password: config.RedisPassword,
});
const jibriTracker = new JibriTracker(logger, redisClient);
const instanceStatus = new InstanceStatus({ redisClient, jibriTracker });
const h = new Handlers(jibriTracker, instanceStatus);
const asapFetcher = new ASAPPubKeyFetcher(logger, config.AsapPubKeyBaseUrl, config.AsapPubKeyTTL);

const cloudManager = new CloudManager({
    instanceStatus: instanceStatus,
    isDryRun: config.DryRun,
});

const autoscaleProcessor = new Autoscaler({
    jibriTracker: jibriTracker,
    cloudManager: cloudManager,
    jibriGroupList: config.GroupList,
});

app.use(
    jwt({
        secret: asapFetcher.pubKeyCallback,
        audience: config.AsapJwtAcceptedAud,
        issuer: config.AsapJwtAcceptedHookIss,
        algorithms: ['RS256'],
    }).unless((req) => {
        if (req.path == '/health') return true;
        return config.ProtectedApi === 'false';
    }),
);
if (config.ProtectedApi) {
    logger.debug('starting in protected api mode');
} else {
    logger.warn('starting in unprotected api mode');
}

// add a logger middleware
app.use((req, res, done) => {
    logger.info('', { method: req.method, url: req.originalUrl, status: res.statusCode });
    done();
});

app.post('/hook/v1/status', async (req, res, next) => {
    try {
        await h.jibriStateWebhook(req, res);
    } catch (err) {
        next(err);
    }
});

app.post('/sidecar/poll', async (req, res, next) => {
    try {
        await h.sidecarPoll(req, res);
    } catch (err) {
        next(err);
    }
});

app.post('/sidecar/stats', async (req, res, next) => {
    try {
        await h.sidecarStats(req, res);
    } catch (err) {
        next(err);
    }
});

async function pollForAutoscaling() {
    await autoscaleProcessor.processAutoscaling();
    setTimeout(pollForAutoscaling, config.AutoscalerInterval * 1000);
}
pollForAutoscaling();

// async function pollForRequestUpdates() {
//     await requestTracker.processUpdates(meetProcessor.updateProcessor);
//     setTimeout(pollForRequestUpdates, 3000);
// }
// pollForRequestUpdates();

app.listen(config.HTTPServerPort, () => {
    logger.info(`...listening on :${config.HTTPServerPort}`);
});
