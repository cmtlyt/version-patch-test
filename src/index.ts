import { exec } from '@actions/exec';
import { context } from '@actions/github';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import semver from 'semver';
import core, { logger } from './core';

async function signUser() {
  await exec('git', ['config', '--global', 'user.name', 'GitHub Action']);
  await exec('git', ['config', '--global', 'user.email', 'action@github.com']);
}

async function run() {
  try {
    const targetBranch = context.ref.split('/').pop()!;

    if (targetBranch !== 'alpha' && targetBranch !== 'beta' && targetBranch !== 'main') {
      logger.info(`不支持的分支: ${targetBranch}`);
      return;
    }

    logger.info(`labels: ${JSON.stringify(context.payload.pull_request?.labels || {})}`);

    logger.info('sign action user');
    await signUser();

    // 读取当前版本号
    const pkgPath = await resolvePackageJSON();
    const pkgInfo = await readPackageJSON(pkgPath);
    const currentVersion = pkgInfo.version!;
    logger.info(`当前版本: ${currentVersion}`);

    // 计算新版本
    let newVersion: string | null = null;

    if (targetBranch === 'alpha') {
      const lastSemver = semver.parse(currentVersion);
      if (lastSemver && (!lastSemver.prerelease || lastSemver.prerelease[0] !== 'alpha')) {
        logger.info(`上一个版本 (${currentVersion}) 来自 beta 或 main, 需要提升 minor 版本。`);
        newVersion = semver.inc(currentVersion, 'prepatch', 'alpha');
      } else {
        // 升级 alpha 补丁版本
        newVersion = semver.inc(currentVersion, 'prerelease', 'alpha');
      }
    } else if (targetBranch === 'beta') {
      // beta 补丁升级
      newVersion = semver.inc(currentVersion, 'prerelease', 'beta');
    } else if (targetBranch === 'main') {
      // 去除 preid, 转为正式版本
      newVersion = semver.inc(currentVersion, 'patch');
    }

    logger.info(`新版本: ${newVersion}`);

    // 更新版本文件
    pkgInfo.version = newVersion!;
    await writePackageJSON(pkgPath, pkgInfo);
    logger.info('版本文件已更新');

    // 提交更改
    await exec('git', ['add', pkgPath]);
    await exec('git', ['commit', '-m', `chore: bump version to ${newVersion} for ${targetBranch}`]);
    await exec('git', ['push', 'origin', targetBranch]);

    core.exportVariable('GIT_MERGE_AUTOEDIT', 'no');
    if (targetBranch === 'beta') {
      await exec('git', ['fetch', 'origin', 'alpha']);
      await exec('git', ['switch', 'alpha']);
      const alphaPkgInfo = await readPackageJSON(pkgPath);
      logger.info(`alpha version ${alphaPkgInfo.version}`);
      logger.info(`beta version ${newVersion}`);
      await exec('git', [
        'merge',
        'beta',
        '--no-edit',
        '--no-ff',
        '-m',
        `chore: sync beta v${newVersion} to alpha [skip ci]`,
      ]).catch(async () => {
        logger.warning('Alpha 合并冲突');
        if (semver.gt(alphaPkgInfo.version!, newVersion!)) {
          logger.info('Alpha 版本号大于 beta 版本号, 忽略版本变更');
          const newAlphaPkgInfo = await readPackageJSON(pkgPath);
          newAlphaPkgInfo.version = alphaPkgInfo.version;
          logger.info(`alpha pkg info: ${JSON.stringify(newAlphaPkgInfo)}`);
          await writePackageJSON(pkgPath, newAlphaPkgInfo);
          await exec('git', ['add', '.']);
          await exec('git', ['commit', '-m', `chore: sync beta v${newVersion} to alpha [skip ci]`]);
        } else {
          logger.error('Alpha 版本号小于 beta 版本号, 无法自动合并, 尝试打开 pr 进行处理');
        }
      });
      await exec('git', ['push', 'origin', 'alpha', '--force-with-lease']).catch(() => {
        logger.info('Alpha 推送失败');
      });
    } else if (targetBranch === 'main') {
      await exec('git', ['fetch', 'origin', 'main']);
      await exec('git', ['fetch', 'origin', 'beta']);
      await exec('git', ['switch', 'beta']);
      await exec('git', [
        'merge',
        'origin/main',
        '--no-edit',
        '--no-ff',
        '-m',
        `chore: sync main v${newVersion} to beta [skip ci]`,
      ]).catch(async () => {
        logger.info('Beta 合并冲突, 强制同步');
        await exec('git', ['reset', '--hard', 'origin/main']);
        await exec('git', ['commit', '--allow-empty', '-m', `chore: force sync from main v${newVersion} [skip ci]`]);
      });
      await exec('git', ['push', 'origin', 'beta', '--force-with-lease']).catch(() => {
        logger.info('Beta 推送失败');
      });
    }

    // 输出新版本
    core.setOutput('next-version', newVersion);
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
