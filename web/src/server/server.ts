import {
  OverrideMiddleware,
  LogIncomingRequestMiddleware,
  Req,
  ServerLoader,
  ServerSettings,
} from "ts-express-decorators";
import * as bugsnag from "bugsnag";
import * as cors from "cors";
import { $log } from "ts-log-debug";
import * as path from "path";
import * as Express from "express";
import * as RateLimit from "express-rate-limit";
import { TSEDVerboseLogging } from "../logger";
import { initMysqlPool } from "../util/persistence/mysql";

@ServerSettings({
  rootDir: path.resolve(__dirname),
  mount: {
    "/": "${rootDir}/../controllers/**/*.js",
  },
  acceptMimes: ["application/json"],
  port: 3000,
  httpsPort: 0,
  componentsScan: [
    "${rootDir}/../util/services/**/**.js",
    "${rootDir}/../installers/**/**.js",
    "${rootDir}/**/**.js",
  ],
  logger: {
    level: "info",
  },
})

export class Server extends ServerLoader {

  constructor(
    private readonly bugsnagKey: string,
  ) {
    super();
  }

  public async $onInit(): Promise<void> {
    await initMysqlPool();
  }

  /**
   * This method let you configure the middleware required by your application to works.
   * @returns {Server}
   */
  public async $onMountingMiddlewares(): Promise<void> {
    this.expressApp.enable("trust proxy");  // so we get the real ip from the ELB in amaazon
    const bodyParser = require("body-parser");

    if (process.env["BUGSNAG_KEY"]) {
      bugsnag.register(process.env["BUGSNAG_KEY"] || "");
      this.use(bugsnag.requestHandler);
    }

    this.use(bodyParser.json());
    this.use(bodyParser.urlencoded({
      type: "application/x-www-form-urlencoded",
      extended: false,
    }));
    this.use(bodyParser.text({
      type: ["text/plain", "text/yaml", "text/x-yaml", "application/x-yaml"],
    }));

    this.use(cors());

    if (process.env["BUGSNAG_KEY"]) {
      this.use(bugsnag.errorHandler);
    }

    if (process.env["IGNORE_RATE_LIMITS"] !== "1") {
      // this limiter applies to all requests to the service.
      let globalLimiter = new RateLimit({
        windowMs: 1000, // 1 second
        max: 10000, // limit each IP to 10000 requests per windowMs
        delayMs: 0, // disable delaying - full speed until the max limit is reached
      });
      this.use(globalLimiter);
    }
  }

  public $onServerInitError(err) {
    $log.error(err);
  }
}

const verboseLogging = TSEDVerboseLogging;

@OverrideMiddleware(LogIncomingRequestMiddleware)
export class CustomLogIncomingRequestMiddleware extends LogIncomingRequestMiddleware {

  public use(@Req() request): void {
    // you can set a custom ID with another lib
    request.id = require("uuid").v4();
    request.start = new Date().getTime();
    return super.use(request); // required
  }

  // pretty much copy-pasted, but hooked into verboseLogging from above to control multiline logging
  protected stringify(request: Express.Request, propertySelector: (e: Express.Request) => any): (scope: any) => string {
    return (scope) => {
      if (!scope) {
        scope = {};
      }

      if (typeof scope === "string") {
        scope = {message: scope};
      }

      scope = Object.assign(scope, propertySelector(request));
      try {
        if (verboseLogging) { // this is the only line that's different
          return JSON.stringify(scope, null, 2);
        }
        return JSON.stringify(scope);
      } catch (err) {
        $log.error({error: err});
      }
      return "";
    };
  }

  protected requestToObject(request) {
    if (request.originalUrl === "/healthz" || request.url === "/healthz") {
      return {
        url: "/healthz",
      };
    }

    if (verboseLogging) {
      return {
        reqId: request.id,
        method: request.method,
        url: request.originalUrl || request.url,
        duration: new Date().getTime() - request.start,
        headers: request.headers,
        body: request.body,
        query: request.query,
        params: request.params,
      };
    } else {
      return {
        reqId: request.id,
        method: request.method,
        url: request.originalUrl || request.url,
        duration: new Date().getTime() - request.start,
      };
    }
  }

  protected onLogEnd(request, response) {
    if (this.requestToObject(request).url === "/healthz") {
      delete request.log;
      return;
    }
    return super.onLogEnd(request, response);
  }
}
