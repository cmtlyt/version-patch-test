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
        logger.info(`上一个版本 (${currentVersion}) 来自 beta 或 main，需要提升 minor 版本。`);
        newVersion = semver.inc(currentVersion, 'prepatch', 'alpha');
      } else {
        // 升级 alpha 补丁版本
        newVersion = semver.inc(currentVersion, 'prerelease', 'alpha');
      }
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
      // git merge origin/beta --no-edit --no-ff -m "chore: sync beta v${latest_tag} to alpha [skip ci]" || {
      //   echo "Alpha 合并冲突，强制同步"
      //   git reset --hard origin/beta
      //   git commit --allow-empty -m "chore: force sync from beta v${latest_tag} [skip ci]"
      // }

      // git push origin alpha --force-with-lease || echo "Alpha 推送失败"
      await exec('git', ['fetch', 'origin', 'beta']);
      await exec('git', ['fetch', 'origin', 'alpha']);
      await exec('git', ['switch', 'alpha']);
      await exec('git', [
        'merge',
        'origin/beta',
        '--no-edit',
        '--no-ff',
        '-m',
        `chore: sync beta v${newVersion} to alpha [skip ci]`,
      ]).catch(async () => {
        logger.info('Alpha 合并冲突，强制同步');
        await exec('git', ['reset', '--hard', 'origin/beta']);
        await exec('git', ['commit', '--allow-empty', '-m', `chore: force sync from beta v${newVersion} [skip ci]`]);
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
        logger.info('Beta 合并冲突，强制同步');
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
