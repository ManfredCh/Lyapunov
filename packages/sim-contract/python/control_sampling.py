"""Provider 的控制边界适配。时序对照固定 Lab record_pre_step/post_step；不拥有物理循环。"""
import copy


class ControlSampler:
    def __init__(self, world, emit, error):
        self.world, self.emit, self.error = world, emit, error
        self.config = None
        self.pending = {}
        self.count = 0
        self.joint_units = {}

    def configure(self, options):
        w = self.world
        if options.get('expectedGeneration') != w.generation and options.get('enabled'):
            raise self.error('STALE_GENERATION', '采样请求属于旧世界代次')
        if not isinstance(options.get('enabled'), bool):
            raise self.error('INVALID_ARGUMENT', 'enabled 必须为布尔值')
        if options['enabled']:
            if w.clock != 'manual':
                raise self.error('UNSUPPORTED_CAPABILITY', '控制步采样首版需要显式 manual 世界')
            if self.config is not None:
                raise self.error('CONTROL_SAMPLING_BUSY', '世界已有控制采样作业')
            if any(not isinstance(options.get(k), str) or not options[k].strip() for k in ('episodeId', 'entityId')):
                raise self.error('INVALID_ARGUMENT', 'episodeId/entityId 必须为非空字符串')
            description = w.describe(options['entityId'])
            if not description.get('controlledJointNames'):
                raise self.error('UNSUPPORTED_CAPABILITY', '目标没有已核验的受控关节')
            if getattr(w, 'active', getattr(w, 'actions', {})):
                raise self.error('ENTITY_BUSY', '开始采样前需要完成当前动作')
            self.config = copy.deepcopy(options)
            self.joint_units = {j['name']: j['unit'] for j in description['joints']}
            self.count = 0
        else:
            if self.config and any(options.get(k) != self.config[k] for k in ('episodeId', 'entityId')):
                raise self.error('CONTROL_SAMPLING_OWNER_MISMATCH', '结束请求与采样来源不符')
            for aid in list(self.pending):
                self.finish(aid, 'interrupted', 'recording-stopped')
            self.config = None
        return {**options, 'sampleCount': self.count, 'profile': 'joint-position-reference-v1'}

    def validate(self, action):
        if self.config is None:
            return
        if self.config['expectedGeneration'] != self.world.generation:
            raise self.error('STALE_GENERATION', '采样世界已换代，请结束旧采样')
        motions = action['motions'] if action['kind'] == 'batch' else [action]
        for m in motions:
            if m['entityId'] == self.config['entityId'] and m['kind'] != 'control':
                raise self.error('UNSUPPORTED_CAPABILITY', '当前示教 profile 仅接受位置参考 control')

    def before(self, aid, motions):
        if self.config is None or aid in self.pending:
            return
        if self.config['expectedGeneration'] != self.world.generation:
            return
        selected = [m for m in motions if m['entityId'] == self.config['entityId'] and m['kind'] == 'control']
        if not selected:
            return
        m = selected[0]
        frame = self.world.observe()
        self.pending[aid] = (copy.deepcopy(m), copy.deepcopy(frame), self.count)
        self.count += 1

    def stop(self, selection):
        for aid, (motion, _frame, _cycle) in list(self.pending.items()):
            if selection.get('actionId') and selection['actionId'] != aid:
                continue
            if selection.get('entityIds') and motion['entityId'] not in selection['entityIds']:
                continue
            self.finish(aid, 'cancelled', 'STOP_CONFIRMED')

    def finish(self, aid, status, reason=None):
        if aid not in self.pending:
            return
        m, before, cycle = self.pending.pop(aid)
        try:
            after = copy.deepcopy(self.world.observe())
        except Exception as exc:
            after = None
            reason = reason or 'OBSERVATION_UNAVAILABLE: ' + str(exc)
        end_step = after['stepIndex'] if after is not None else getattr(self.world, 'step_index', getattr(self.world, 'index', before['stepIndex']))
        end_time = after['simTime'] if after is not None else (float(self.world.data.time) if hasattr(self.world, 'data') else float(self.world.sim_time))
        dt = float(self.world.model.opt.timestep) if hasattr(self.world, 'model') else float(self.world.dt)
        requested = m['stepCount']
        applied = end_step - before['stepIndex']
        sample = {'schemaVersion': 1, 'profile': 'joint-position-reference-v1',
                  'episodeId': self.config['episodeId'], 'controlCycleIndex': cycle,
                  'worldId': before['worldId'], 'generation': before['generation'],
                  'sceneRevision': before['sceneRevision'], 'entityId': m['entityId'], 'actionId': aid,
                  'jointNames': list(m['jointNames']), 'jointUnits': [self.joint_units[n] for n in m['jointNames']],
                  'positions': list(m['positions']),
                  'physicsStepStart': before['stepIndex'], 'physicsStepEnd': end_step,
                  'simTimeStart': before['simTime'], 'simTimeEnd': end_time,
                  'physicsTimestepS': dt, 'requestedSteps': requested, 'appliedSteps': applied,
                  'complete': status == 'completed' and after is not None and applied == requested,
                  'status': status, 'before': before, 'after': after}
        if reason:
            sample['reason'] = reason
        self.emit({'event': 'control-sample', 'sample': sample})
