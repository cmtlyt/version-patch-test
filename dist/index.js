import "@actions/exec";
import { context } from "@actions/github";
import "pkg-types";
import "semver";
import * as __WEBPACK_EXTERNAL_MODULE__actions_core_28c3e8e8__ from "@actions/core";
const logger = {
    debug: __WEBPACK_EXTERNAL_MODULE__actions_core_28c3e8e8__.debug,
    info: __WEBPACK_EXTERNAL_MODULE__actions_core_28c3e8e8__.info,
    warning: __WEBPACK_EXTERNAL_MODULE__actions_core_28c3e8e8__.warning
};
const core = __WEBPACK_EXTERNAL_MODULE__actions_core_28c3e8e8__;
async function run() {
    try {
        const targetBranch = context.ref;
        logger.info(`${targetBranch}: ${JSON.stringify(context.payload)}`);
        return;
    } catch (error) {
        core.setFailed(error.message);
    }
}
run();
