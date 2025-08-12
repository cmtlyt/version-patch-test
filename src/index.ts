import { exec } from '@actions/exec';
import { context } from '@actions/github';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import semver from 'semver';
import core, { logger } from './core';

async function run() {
  try {
    const targetBranch = context.ref.split('/').pop()!;

    if (targetBranch !== 'alpha' && targetBranch !== 'beta' && targetBranch !== 'main') {
      logger.info(`不支持的分支: ${targetBranch}`);
      return;
    }

    // if (context.eventName !== 'pull_request') {
    //   logger.info('不是 PR 触发');
    //   return;
    // }

    // 读取当前版本号
    const pkgPath = await resolvePackageJSON();
    const pkgInfo = await readPackageJSON(pkgPath);
    const currentVersion = pkgInfo.version!;
    logger.info(`当前版本: ${currentVersion}`);

    // 计算新版本
    let newVersion: string | null = null;

    if (targetBranch === 'alpha') {
      // 升级 alpha 补丁版本
      newVersion = semver.inc(currentVersion, 'prerelease', 'alpha');
    } else if (targetBranch === 'beta') {
      // beta 补丁升级
      newVersion = semver.inc(currentVersion, 'prerelease', 'beta');
    } else if (targetBranch === 'main') {
      // 去除 preid，转为正式版本
      newVersion = semver.inc(currentVersion, 'patch');
    } else {
      throw new Error(`不支持的分支: ${targetBranch}`);
    }

    logger.info(`新版本: ${newVersion}`);

    return;

    // 更新版本文件
    pkgInfo.version = newVersion!;
    await writePackageJSON(pkgPath, pkgInfo);
    logger.info('版本文件已更新');

    // 提交更改
    await exec('git', ['add', pkgPath]);
    await exec('git', ['commit', '-m', `chore: bump version to ${newVersion} for ${targetBranch}`]);
    await exec('git', ['push', 'origin', targetBranch]);

    // Rebase 操作
    if (targetBranch === 'beta') {
      await exec('git', ['fetch', 'origin', 'beta']);
      await exec('git', ['checkout', 'alpha']);
      await exec('git', ['rebase', 'origin/beta']);
      await exec('git', ['push', 'origin', 'alpha', '--force']);
    } else if (targetBranch === 'main') {
      await exec('git', ['fetch', 'origin', 'main']);
      await exec('git', ['checkout', 'beta']);
      await exec('git', ['rebase', 'origin/main']);
      await exec('git', ['push', 'origin', 'beta', '--force']);
    }

    // 输出新版本
    core.setOutput('next-version', newVersion);
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
