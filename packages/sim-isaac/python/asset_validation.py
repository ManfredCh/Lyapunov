"""在独立 Kit worker 中调用已安装的 Isaac 资产规则。"""
import hashlib
from pathlib import Path


def validate_asset(options, manager, sdk_version):
    from pxr import Sdf, Usd

    if not manager.set_extension_enabled_immediate('isaacsim.asset.validation', True):
        raise RuntimeError('ISAAC_VALIDATOR_UNAVAILABLE')
    from omni.asset_validator.core import ValidationEngine
    from isaacsim.asset.validation import physics_rules, robot_rules

    source = Path(options['path'])
    with source.open('rb') as stream:
        before = hashlib.file_digest(stream, 'sha256').hexdigest()
    root_layer = Sdf.Layer.FindOrOpen(str(source))
    stage = Usd.Stage.Open(root_layer, Sdf.Layer.CreateAnonymous()) if root_layer else None
    if stage is None:
        raise ValueError('ISAAC_ASSET_STAGE_UNREADABLE')
    static = [physics_rules.RigidBodyHasCollider]
    if options['profile'] in ('explicit-mass', 'robot'):
        static.append(physics_rules.RigidBodyHasMassAPI)
    if options['profile'] == 'robot':
        static.extend([physics_rules.HasArticulationRoot, robot_rules.RobotSchema,
                       robot_rules.JointsExist, robot_rules.LinksExist, robot_rules.CheckRobotRelationships])

    def run(rules):
        engine = ValidationEngine(init_rules=False, variants=False)
        for rule in rules:
            engine.enable_rule(rule)
        result = engine.validate(stage)
        return {'rules': [rule.__name__ for rule in rules], 'issues': [
            {'rule': issue.rule.__name__ if isinstance(issue.rule, type) else str(issue.rule or ''),
             'severity': issue.severity.name if issue.severity else 'UNKNOWN',
             'message': issue.message, 'at': str(issue.at) if issue.at else None}
            for issue in result.issues if issue.message
        ]}

    static_report = run(static)
    dynamic_report = run([physics_rules.NonAdjacentCollisionMeshesDoNotClash]) if options.get('simulate') else None
    with source.open('rb') as stream:
        after = hashlib.file_digest(stream, 'sha256').hexdigest()
    if before != after:
        raise RuntimeError('ISAAC_ASSET_CHANGED_DURING_VALIDATION')
    return {'status': 'CHECKED', 'sdkVersion': sdk_version, 'sourceSha256': before,
            'profile': options['profile'], 'static': static_report, 'simulation': dynamic_report}
