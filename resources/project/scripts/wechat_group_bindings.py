"""Account-scoped group identities. Display names never identify new groups."""
import contextlib
import hashlib
import json
import os
import pathlib
import re
import threading
import time


def group_username(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,200}@chatroom', value) is not None


def numeric_id(value):
    return isinstance(value, str) and value.isascii() and value.isdigit() and 0 < int(value) <= 9007199254740991


def legacy_group_id(name):
    value = re.sub(r'\s*\([0-9]+\)\s*$', '', name).strip()
    return str(int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], 'big') % 2147483647 + 1)


class GroupBindings:
    def __init__(self, root, account, readonly=False):
        self.scope = hashlib.sha256(str(pathlib.Path(account).resolve()).casefold().encode()).hexdigest()
        self.file = pathlib.Path(root) / 'state/group-bindings' / (self.scope + '.json')
        self.readonly = readonly
        self.lock = threading.RLock()
        self.records = self._read()

    def _read(self):
        if not self.file.exists():
            return {}
        if self.file.stat().st_size > 8 * 1024 * 1024:
            raise RuntimeError('GROUP_BINDINGS_INVALID')
        try:
            data = json.loads(self.file.read_text(encoding='utf-8'))
            records = data['groups']
            if data['version'] != 1 or data['scope'] != self.scope or not isinstance(records, dict) or len(records) > 10000:
                raise ValueError()
            ids = set()
            for username, item in records.items():
                if not group_username(username) or not numeric_id(item['id']) or item['id'] in ids:
                    raise ValueError()
                if not isinstance(item['name'], str) or len(item['name']) > 500 or not isinstance(item['aliases'], list) or len(item['aliases']) > 12 or any(not isinstance(a, str) or len(a) > 500 for a in item['aliases']):
                    raise ValueError()
                ids.add(item['id'])
            return records
        except (ValueError, KeyError, TypeError):
            raise RuntimeError('GROUP_BINDINGS_INVALID') from None

    @contextlib.contextmanager
    def transaction(self):
        with self.lock:
            self.file.parent.mkdir(parents=True, exist_ok=True)
            with self.file.with_suffix('.lock').open('a+b') as handle:
                handle.seek(0, 2)
                if handle.tell() == 0:
                    handle.write(b'0'); handle.flush()
                until = time.monotonic() + 2
                while True:
                    try:
                        handle.seek(0)
                        if os.name == 'nt':
                            import msvcrt
                            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except OSError:
                        if time.monotonic() >= until:
                            raise RuntimeError('GROUP_BINDINGS_BUSY') from None
                        time.sleep(.01)
                try:
                    self.records = self._read()
                    yield
                finally:
                    handle.seek(0)
                    if os.name == 'nt':
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _save(self):
        text = json.dumps({'version': 1, 'scope': self.scope, 'groups': self.records}, ensure_ascii=False)
        if len(text.encode('utf-8')) > 8*1024*1024:
            raise RuntimeError('GROUP_BINDINGS_LIMIT')
        temporary = self.file.with_suffix('.' + str(os.getpid()) + '.tmp')
        temporary.write_text(text, encoding='utf-8')
        temporary.replace(self.file)

    def _new_id(self, username, reserved):
        for salt in range(1000):
            value = 'wechat-group-v2\0' + self.scope + '\0' + username + ('\0' + str(salt) if salt else '')
            candidate = str(int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], 'big') % 2147483647 + 1)
            if candidate not in reserved:
                return candidate
        raise RuntimeError('GROUP_BINDINGS_ID_EXHAUSTED')

    def reconcile(self, names, allowed=(), hints=None, aliases=None):
        if self.readonly:
            return
        groups = {u: str(n or u)[:500] for u, n in names.items() if group_username(u)}
        allowed = {str(i) for i in allowed}
        hints = hints or {}
        owners = {}
        for username, name in groups.items():
            candidate = hints.get(username) or legacy_group_id(name)
            if candidate in allowed:
                owners.setdefault(candidate, set()).add(username)
        with self.transaction():
            before = json.dumps(self.records, sort_keys=True)
            used = {item['id'] for item in self.records.values()}
            reserved = allowed | used
            for username, name in sorted(groups.items()):
                item = self.records.get(username)
                if item is None:
                    candidate = hints.get(username) or legacy_group_id(name)
                    keep = candidate in allowed and owners.get(candidate) == {username} and candidate not in used
                    identity = candidate if keep else self._new_id(username, reserved)
                    reserved.add(identity)
                    used.add(identity)
                    item = self.records[username] = {'id': identity, 'name': name, 'aliases': []}
                if item['name'] != name and item['name'] not in item['aliases']:
                    item['aliases'] = (item['aliases'] + [item['name']])[-12:]
                item['name'] = name
                for alias in (aliases or {}).get(username, []):
                    if isinstance(alias, str) and alias and alias != name and alias[:500] not in item['aliases']:
                        item['aliases'] = (item['aliases'] + [alias[:500]])[-12:]
            if len(self.records) > 10000:
                raise RuntimeError('GROUP_BINDINGS_LIMIT')
            if before != json.dumps(self.records, sort_keys=True):
                self._save()

    def identifier(self, username):
        with self.lock:
            item = self.records.get(username)
            if item:
                return item['id']
        # Unknown/unobserved groups cannot guess an authorized numeric ID.
        return None

    def bind(self, username, identity, allowed, observed):
        if self.readonly or not group_username(username) or not numeric_id(identity) or identity not in map(str, allowed) or username not in observed:
            raise RuntimeError('GROUP_BINDING_NOT_ALLOWED')
        with self.transaction():
            current = self.records.get(username)
            if not current:
                raise RuntimeError('GROUP_METADATA_NOT_READY')
            if any(u != username and item['id'] == identity for u, item in self.records.items()):
                raise RuntimeError('GROUP_BINDING_ALREADY_ASSIGNED')
            if current['id'] != identity and current['id'] in map(str, allowed):
                raise RuntimeError('GROUP_BINDING_ALREADY_SELECTED')
            current['id'] = identity
            self._save()
        return identity
